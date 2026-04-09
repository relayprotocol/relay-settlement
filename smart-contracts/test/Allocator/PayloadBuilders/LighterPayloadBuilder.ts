// ABOUTME: Unit tests for LighterPayloadBuilder contract.
// ABOUTME: Tests buildPayload, hashToSign, L1 message format, signature roundtrip, and access control.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  serializeTransaction,
  Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { deployAllocator } from "../../helpers/deployAllocator"

const LIGHTER_PAYLOAD_ABI = parseAbiParameters([
  "(uint8 actionType, bytes parameters)",
])
const TRANSFER_REQUEST_ABI = parseAbiParameters([
  "(uint64 nonce, uint64 fromAccountIndex, uint64 fromRouteType, uint64 apiKeyIndex, uint64 toAccountIndex, uint64 toRouteType, uint64 assetIndex, uint64 amount, uint64 usdcFee, uint64 lighterChainId, bytes32 memo)",
])
const CHANGE_PUB_KEY_TX_ABI = parseAbiParameters([
  "(uint256 txNonce, uint256 gasPrice, uint256 gasLimit, bytes data)",
])

const FROM_ACCOUNT_INDEX = 10n
const LIGHTER_CHAIN_ID = 304n
const GATEWAY_CHAIN_ID = 1n // Ethereum mainnet
const SAMPLE_PUBKEY = ("0x" + "ab".repeat(40)) as Hex
const LIGHTER_GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7"

function encodeTransferData(p: {
  nonce: bigint
  fromRouteType: bigint
  toRouteType: bigint
  apiKeyIndex: bigint
  usdcFee: bigint
  memo: Hex
}) {
  return encodeAbiParameters(
    parseAbiParameters([
      "uint8, uint64, uint64, uint64, uint64, uint64, bytes32",
    ]),
    [
      0,
      p.nonce,
      p.fromRouteType,
      p.toRouteType,
      p.apiKeyIndex,
      p.usdcFee,
      p.memo,
    ]
  )
}

function encodeChangePubKeyData(p: {
  pubkey: Hex
  apiKeyIndex: bigint
  txNonce: bigint
  gasPrice: bigint
  gasLimit: bigint
}) {
  return encodeAbiParameters(
    parseAbiParameters(["uint8, bytes, uint64, uint256, uint256, uint256"]),
    [1, p.pubkey, p.apiKeyIndex, p.txNonce, p.gasPrice, p.gasLimit]
  )
}

function decodePayload(payload: Hex) {
  const [outer] = decodeAbiParameters(LIGHTER_PAYLOAD_ABI, payload) as any[]
  return {
    actionType: outer.actionType as number,
    parameters: outer.parameters as Hex,
  }
}

const h16 = (v: bigint) => "0x" + v.toString(16).padStart(16, "0")

function buildTransferL1MessageTS(p: {
  nonce: bigint
  fromAccountIndex: bigint
  fromRouteType: bigint
  apiKeyIndex: bigint
  toAccountIndex: bigint
  toRouteType: bigint
  assetIndex: bigint
  amount: bigint
  usdcFee: bigint
  lighterChainId: bigint
  memo: string
}): string {
  return [
    "Transfer",
    "",
    `nonce: ${h16(p.nonce)}`,
    `from: ${h16(p.fromAccountIndex)} (route ${h16(p.fromRouteType)})`,
    `api key: ${h16(p.apiKeyIndex)}`,
    `to: ${h16(p.toAccountIndex)} (route ${h16(p.toRouteType)})`,
    `asset: ${h16(p.assetIndex)}`,
    `amount: ${h16(p.amount)}`,
    `fee: ${h16(p.usdcFee)}`,
    `chainId: ${h16(p.lighterChainId)}`,
    `memo: ${p.memo.padEnd(64, "0")}`,
    "Only sign this message for a trusted client!",
  ].join("\n")
}

function personalSignHash(message: string): Hex {
  const messageBytes = new TextEncoder().encode(message)
  const prefix = `\x19Ethereum Signed Message:\n${messageBytes.length}`
  const prefixBytes = new TextEncoder().encode(prefix)
  const combined = new Uint8Array(prefixBytes.length + messageBytes.length)
  combined.set(prefixBytes)
  combined.set(messageBytes, prefixBytes.length)
  return keccak256(("0x" + Buffer.from(combined).toString("hex")) as Hex)
}

describe("Allocator LighterPayloadBuilder", function () {
  async function deployLighterPayloadBuilder() {
    const [depository, receiver] = await hre.viem.getWalletClients()
    const { allocator, owner: admin } = await deployAllocator()

    const payloadBuilder = await hre.viem.deployContract(
      "LighterPayloadBuilder",
      [allocator.address, FROM_ACCOUNT_INDEX, LIGHTER_GATEWAY, GATEWAY_CHAIN_ID]
    )

    await payloadBuilder.write.setRouteTypeWhitelisted([0n, true], {
      account: admin.account,
    })
    await payloadBuilder.write.setRouteTypeWhitelisted([1n, true], {
      account: admin.account,
    })

    return { admin, allocator, depository, payloadBuilder, receiver }
  }

  describe("constructor", function () {
    it("should initialize with correct config", async () => {
      const { payloadBuilder } = await loadFixture(deployLighterPayloadBuilder)
      expect(await payloadBuilder.read.FROM_ACCOUNT_INDEX()).to.equal(
        FROM_ACCOUNT_INDEX
      )
      expect(
        (await payloadBuilder.read.LIGHTER_GATEWAY()).toLowerCase()
      ).to.equal(LIGHTER_GATEWAY.toLowerCase())
      expect(await payloadBuilder.read.GATEWAY_CHAIN_ID()).to.equal(
        GATEWAY_CHAIN_ID
      )
    })
  })

  describe("setApiKeyWhitelisted()", function () {
    it("should allow owner to whitelist an API key", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployLighterPayloadBuilder
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 5n, true],
        { account: admin.account }
      )
      const key = keccak256(
        encodeAbiParameters(parseAbiParameters(["bytes, uint8"]), [
          SAMPLE_PUBKEY,
          5,
        ])
      )
      expect(await payloadBuilder.read.apiKeyWhitelist([key])).to.equal(true)
    })

    it("should revert for non-owner", async () => {
      const { payloadBuilder, receiver } = await loadFixture(
        deployLighterPayloadBuilder
      )
      try {
        await payloadBuilder.write.setApiKeyWhitelisted(
          [SAMPLE_PUBKEY, 5n, true],
          { account: receiver.account }
        )
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("NotRelayAllocatorOwner")
      }
    })

    it("should revert for reserved apiKeyIndex", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployLighterPayloadBuilder
      )
      try {
        await payloadBuilder.write.setApiKeyWhitelisted(
          [SAMPLE_PUBKEY, 3n, true],
          { account: admin.account }
        )
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidApiKeyIndex")
      }
    })

    it("should accept minimum valid apiKeyIndex (4)", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployLighterPayloadBuilder
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 4n, true],
        { account: admin.account }
      )
      const key = keccak256(
        encodeAbiParameters(parseAbiParameters(["bytes, uint8"]), [
          SAMPLE_PUBKEY,
          4,
        ])
      )
      expect(await payloadBuilder.read.apiKeyWhitelist([key])).to.equal(true)
    })
  })

  // ====== Transfer ======

  describe("buildPayload() — Transfer", function () {
    it("should build correct Transfer payload", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const memo =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex
      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 0n,
        memo,
        nonce: 42n,
        toRouteType: 1n,
        usdcFee: 100n,
      })

      const payload = await payloadBuilder.read.buildPayload([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        "0",
        1000000n,
        "99",
        data,
      ])
      const { actionType, parameters } = decodePayload(payload as Hex)
      expect(actionType).to.equal(0)

      const [decoded] = decodeAbiParameters(
        TRANSFER_REQUEST_ABI,
        parameters
      ) as any[]
      expect(decoded.nonce).to.equal(42n)
      expect(decoded.fromAccountIndex).to.equal(FROM_ACCOUNT_INDEX)
      expect(decoded.toAccountIndex).to.equal(99n)
      expect(decoded.amount).to.equal(1000000n)
      expect(decoded.lighterChainId).to.equal(LIGHTER_CHAIN_ID)
    })

    it("should revert when data is empty", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          "99",
          "0x",
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidData")
      }
    })

    it("should revert for reserved apiKeyIndex", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeTransferData({
        apiKeyIndex: 3n,
        fromRouteType: 0n,
        memo: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        nonce: 1n,
        toRouteType: 1n,
        usdcFee: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          "99",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidApiKeyIndex")
      }
    })

    it("should revert for apiKeyIndex exceeding uint8 max (256)", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeTransferData({
        apiKeyIndex: 256n,
        fromRouteType: 0n,
        memo: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        nonce: 1n,
        toRouteType: 1n,
        usdcFee: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          "99",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidApiKeyIndex")
      }
    })

    it("should revert for non-whitelisted route type", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 99n,
        memo: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        nonce: 1n,
        toRouteType: 1n,
        usdcFee: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          "99",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidRouteType")
      }
    })

    it("should revert when toAccountIndex exceeds uint48 max", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 0n,
        memo: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
        nonce: 1n,
        toRouteType: 1n,
        usdcFee: 0n,
      })
      const uint48Max = 2n ** 48n - 1n
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          (uint48Max + 1n).toString(),
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("AccountIndexOverflow")
      }
    })
  })

  // ====== ChangePubKey ======

  describe("buildPayload() — ChangePubKey", function () {
    it("should build a CallRequest targeting the proxy contract", async () => {
      const { payloadBuilder, admin, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 5n, true],
        { account: admin.account }
      )

      const data = encodeChangePubKeyData({
        apiKeyIndex: 5n,
        gasLimit: 200000n,
        gasPrice: 20000000000n,
        pubkey: SAMPLE_PUBKEY,
        txNonce: 0n,
      })
      const payload = await payloadBuilder.read.buildPayload([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        "0",
        0n,
        "0",
        data,
      ])

      const { actionType, parameters } = decodePayload(payload as Hex)
      expect(actionType).to.equal(1)

      // Inner payload is a ChangePubKeyTx
      const [decoded] = decodeAbiParameters(
        CHANGE_PUB_KEY_TX_ABI,
        parameters
      ) as any[]
      expect(decoded.txNonce).to.equal(0n)
      expect(decoded.gasPrice).to.equal(20000000000n)
      expect(decoded.gasLimit).to.equal(200000n)
      // calldata should encode changePubKey(uint48, uint8, bytes)
      expect(decoded.data).to.not.equal("0x")
    })

    it("should revert when API key is NOT whitelisted", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeChangePubKeyData({
        apiKeyIndex: 5n,
        gasLimit: 200000n,
        gasPrice: 20000000000n,
        pubkey: SAMPLE_PUBKEY,
        txNonce: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          0n,
          "0",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("UnauthorizedApiKey")
      }
    })

    it("should revert after owner revokes", async () => {
      const { payloadBuilder, admin, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 5n, true],
        { account: admin.account }
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 5n, false],
        { account: admin.account }
      )

      const data = encodeChangePubKeyData({
        apiKeyIndex: 5n,
        gasLimit: 200000n,
        gasPrice: 20000000000n,
        pubkey: SAMPLE_PUBKEY,
        txNonce: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          0n,
          "0",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("UnauthorizedApiKey")
      }
    })
  })

  // ====== L1 message ======

  describe("buildTransferL1Message()", function () {
    it("should match lighter-ts format", async () => {
      const { payloadBuilder } = await loadFixture(deployLighterPayloadBuilder)
      const req = {
        amount: 1000000n,
        apiKeyIndex: 5n,
        assetIndex: 0n,
        fromAccountIndex: FROM_ACCOUNT_INDEX,
        fromRouteType: 0n,
        lighterChainId: LIGHTER_CHAIN_ID,
        memo: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex,
        nonce: 42n,
        toAccountIndex: 99n,
        toRouteType: 1n,
        usdcFee: 100n,
      }
      const solMsg = Buffer.from(
        (
          (await payloadBuilder.read.buildTransferL1Message([req])) as string
        ).slice(2),
        "hex"
      ).toString("utf-8")
      const tsMsg = buildTransferL1MessageTS({
        ...req,
        memo: (req.memo as string).slice(2),
      })
      expect(solMsg).to.equal(tsMsg)
    })
  })

  // ====== hashToSign ======

  describe("hashToSign()", function () {
    it("Transfer — returns personal_sign hash", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const memo =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex
      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 0n,
        memo,
        nonce: 42n,
        toRouteType: 1n,
        usdcFee: 100n,
      })
      const payload = await payloadBuilder.read.buildPayload([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        "0",
        1000000n,
        "99",
        data,
      ])
      const hash = await payloadBuilder.read.hashToSign([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        payload,
        0,
      ])

      const l1Message = buildTransferL1MessageTS({
        amount: 1000000n,
        apiKeyIndex: 5n,
        assetIndex: 0n,
        fromAccountIndex: FROM_ACCOUNT_INDEX,
        fromRouteType: 0n,
        lighterChainId: LIGHTER_CHAIN_ID,
        memo: (memo as string).slice(2),
        nonce: 42n,
        toAccountIndex: 99n,
        toRouteType: 1n,
        usdcFee: 100n,
      })
      expect(hash).to.equal(personalSignHash(l1Message))
    })

    it("ChangePubKey — returns keccak256 of RLP-encoded unsigned EVM tx (EIP-155)", async () => {
      const { payloadBuilder, admin, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      await payloadBuilder.write.setApiKeyWhitelisted(
        [SAMPLE_PUBKEY, 5n, true],
        { account: admin.account }
      )

      const txNonce = 42n
      const gasPrice = 20000000000n
      const gasLimit = 200000n
      const data = encodeChangePubKeyData({
        apiKeyIndex: 5n,
        gasLimit,
        gasPrice,
        pubkey: SAMPLE_PUBKEY,
        txNonce,
      })
      // chainId param is ignored for ChangePubKey — contract uses immutable gatewayChainId
      const payload = await payloadBuilder.read.buildPayload([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        "0",
        0n,
        "0",
        data,
      ])
      const hash = await payloadBuilder.read.hashToSign([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        payload,
        0,
      ])

      // Decode inner ChangePubKeyTx to get the calldata
      const { parameters } = decodePayload(payload as Hex)
      const [decoded] = decodeAbiParameters(
        CHANGE_PUB_KEY_TX_ABI,
        parameters
      ) as any[]

      // Reconstruct using viem's serializeTransaction (produces RLP of unsigned tx)
      // Uses GATEWAY_CHAIN_ID (1) to match the contract's immutable
      const serialized = serializeTransaction({
        chainId: Number(GATEWAY_CHAIN_ID),
        data: decoded.data as Hex,
        gas: gasLimit,
        gasPrice,
        nonce: Number(txNonce),
        to: LIGHTER_GATEWAY as `0x${string}`,
        type: "legacy",
        value: 0n,
      })

      const expectedHash = keccak256(serialized)
      expect(hash).to.equal(expectedHash)
    })

    it("Transfer — wallet.signMessage round-trip", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const account = privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      )
      const memo =
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex

      const l1Message = buildTransferL1MessageTS({
        amount: 1000000n,
        apiKeyIndex: 5n,
        assetIndex: 0n,
        fromAccountIndex: FROM_ACCOUNT_INDEX,
        fromRouteType: 0n,
        lighterChainId: LIGHTER_CHAIN_ID,
        memo: (memo as string).slice(2),
        nonce: 42n,
        toAccountIndex: 99n,
        toRouteType: 1n,
        usdcFee: 100n,
      })
      const signature = await account.signMessage({ message: l1Message })

      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 0n,
        memo,
        nonce: 42n,
        toRouteType: 1n,
        usdcFee: 100n,
      })
      const payload = await payloadBuilder.read.buildPayload([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        "0",
        1000000n,
        "99",
        data,
      ])
      const contractHash = await payloadBuilder.read.hashToSign([
        LIGHTER_CHAIN_ID,
        depository.account.address,
        payload,
        0,
      ])

      const recovered = await recoverAddress({
        hash: contractHash as Hex,
        signature,
      })
      expect(recovered.toLowerCase()).to.equal(account.address.toLowerCase())
    })
  })

  describe("setRouteTypeWhitelisted()", function () {
    it("should revert for non-owner", async () => {
      const { payloadBuilder, receiver } = await loadFixture(
        deployLighterPayloadBuilder
      )
      try {
        await payloadBuilder.write.setRouteTypeWhitelisted([5n, true], {
          account: receiver.account,
        })
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("NotRelayAllocatorOwner")
      }
    })
  })

  describe("buildPayload() — revert cases", function () {
    it("should revert when amount exceeds uint64 max", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const memo =
        "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex
      const data = encodeTransferData({
        apiKeyIndex: 5n,
        fromRouteType: 0n,
        memo,
        nonce: 1n,
        toRouteType: 1n,
        usdcFee: 0n,
      })
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          2n ** 64n,
          "99",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("AmountOverflow")
      }
    })

    it("should revert for invalid action type", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployLighterPayloadBuilder
      )
      const data = encodeAbiParameters(
        parseAbiParameters(["uint8"]),
        [2] // actionType 2 = invalid
      )
      try {
        await payloadBuilder.read.buildPayload([
          LIGHTER_CHAIN_ID,
          depository.account.address,
          "0",
          1000n,
          "99",
          data,
        ])
        expect.fail("Expected revert")
      } catch (e: any) {
        expect(e.message).to.include("InvalidActionType")
      }
    })
  })

  describe("curve()", function () {
    it("should return Ecdsa", async () => {
      const { payloadBuilder } = await loadFixture(deployLighterPayloadBuilder)
      expect(await payloadBuilder.read.curve()).to.equal("Ecdsa")
    })
  })

  describe("family()", function () {
    it("should return lighter-vm", async () => {
      const { payloadBuilder } = await loadFixture(deployLighterPayloadBuilder)
      expect(await payloadBuilder.read.family()).to.equal("lighter-vm")
    })
  })
})
