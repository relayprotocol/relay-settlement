import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbiParameters,
  parseUnits,
  stringToHex,
  toHex,
  zeroAddress,
} from "viem"

const EXPIRATION_DELAY_SECONDS = 10n * 24n * 60n * 60n
const EXPIRATION_TOLERANCE_SECONDS = 10n
const CALL_REQUEST_ABI = [
  {
    components: [
      {
        components: [
          { name: "to", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
          { name: "allowFailure", type: "bool" },
        ],
        name: "calls",
        type: "tuple[]",
      },
      { name: "nonce", type: "uint256" },
      { name: "expiration", type: "uint256" },
    ],
    type: "tuple",
  },
]

async function deployEthereumVmPayloadBuilder() {
  const [owner, depository, receiver] = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()

  const utils = await hre.viem.deployContract("Utils", [])
  const hub = await hre.viem.deployContract("RelayHub", [owner.account.address])
  const allocator = await hre.viem.deployContract(
    "RelayAllocator",
    [owner.account.address, hub.address],
    {
      libraries: {
        Utils: utils.address,
      },
    }
  )
  const config = await hre.viem.deployContract("Config", [allocator.address])
  const payloadBuilder = await hre.viem.deployContract(
    "EthereumVmPayloadBuilder",
    [config.address]
  )
  const expirationKey = await payloadBuilder.read.getExpirationKey()
  await config.write.setConfigValue(
    [expirationKey, toHex(EXPIRATION_DELAY_SECONDS, { size: 32 })],
    { account: owner.account }
  )
  const myToken = await hre.viem.deployContract("MyToken", [])

  return {
    config,
    depository,
    myToken,
    owner,
    payloadBuilder,
    publicClient,
    receiver,
  }
}

describe("EthereumVmPayloadBuilder", function () {
  describe("buildPayload()", function () {
    it("builds a payload when using the native currency", async function () {
      const { payloadBuilder, depository, receiver, publicClient } =
        await loadFixture(deployEthereumVmPayloadBuilder)

      const amount = parseUnits("0.1", 18)
      const latestBlock = await publicClient.getBlock()
      const payload = await payloadBuilder.read.buildPayload([
        "ethereum-mainnet",
        depository.account.address,
        {
          amount,
          currency: zeroAddress,
          data: "0x",
          nonce: 1n,
          receiver: receiver.account.address,
        },
      ])
      const balanceBefore = await publicClient.getBalance({
        address: receiver.account.address,
      })
      const [decodedPayload] = decodeAbiParameters(CALL_REQUEST_ABI, payload)

      const now = latestBlock.timestamp
      expect(
        decodedPayload.expiration >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        decodedPayload.expiration <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(decodedPayload.calls.length).to.equal(1)

      const [call] = decodedPayload.calls
      expect(call.to).to.equal(getAddress(receiver.account.address))
      expect(call.value).to.equal(amount)
      expect(call.allowFailure).to.equal(false)

      await depository.sendTransaction({
        data: call.data,
        to: call.to,
        value: call.value,
      })

      const balanceAfter = await publicClient.getBalance({
        address: receiver.account.address,
      })
      expect(balanceAfter).to.equal(balanceBefore + amount)
    })

    it("derives the nonce from block.number and request-specific payload fields", async function () {
      const { payloadBuilder, depository, receiver, publicClient } =
        await loadFixture(deployEthereumVmPayloadBuilder)

      const amount = parseUnits("0.1", 18)
      const latestBlock = await publicClient.getBlock()
      const payload = await payloadBuilder.read.buildPayload(
        [
          "ethereum-mainnet",
          depository.account.address,
          {
            amount,
            currency: zeroAddress,
            data: "0x",
            nonce: 1n,
            receiver: receiver.account.address,
          },
        ],
        { account: depository.account.address }
      )

      const [decodedPayload] = decodeAbiParameters(CALL_REQUEST_ABI, payload)
      const expectedNonce = BigInt(
        keccak256(
          encodeAbiParameters(
            parseAbiParameters(
              "uint256 blockNumber, uint256 nonce, bytes currency, bytes receiver, bytes data, uint256 amount"
            ),
            [
              latestBlock.number,
              1n,
              zeroAddress,
              receiver.account.address,
              "0x",
              amount,
            ]
          )
        )
      )

      expect(decodedPayload.nonce).to.equal(expectedNonce)
      expect(decodedPayload.nonce).to.not.equal(1n)
    })

    it("builds a payload when using an ERC20 token", async function () {
      const { payloadBuilder, depository, receiver, myToken, publicClient } =
        await loadFixture(deployEthereumVmPayloadBuilder)

      const amount = parseUnits("1337", 18)
      const latestBlock = await publicClient.getBlock()
      await myToken.write.mintFor([amount, depository.account.address])

      const payload = await payloadBuilder.read.buildPayload([
        "ethereum-mainnet",
        depository.account.address,
        {
          amount,
          currency: myToken.address,
          data: "0x",
          nonce: 3n,
          receiver: receiver.account.address,
        },
      ])
      const balanceBefore = await myToken.read.balanceOf([
        receiver.account.address,
      ])
      const [decodedPayload] = decodeAbiParameters(CALL_REQUEST_ABI, payload)

      const now = latestBlock.timestamp
      expect(
        decodedPayload.expiration >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        decodedPayload.expiration <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(decodedPayload.calls.length).to.equal(1)

      const [call] = decodedPayload.calls
      expect(call.to).to.equal(getAddress(myToken.address))
      expect(call.value).to.equal(0n)
      expect(call.allowFailure).to.equal(false)

      await depository.sendTransaction({
        data: call.data,
        to: call.to,
        value: call.value,
      })

      const balanceAfter = await myToken.read.balanceOf([
        receiver.account.address,
      ])
      expect(balanceAfter).to.equal(balanceBefore + amount)
    })

    it("reverts when the receiver is not 20 bytes", async function () {
      const { payloadBuilder, depository } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      await expect(
        payloadBuilder.read.buildPayload([
          "ethereum-mainnet",
          depository.account.address,
          {
            amount: 1n,
            currency: zeroAddress,
            data: "0x",
            nonce: 1n,
            receiver: "0x1234",
          },
        ])
      ).to.be.rejectedWith("InvalidReceiverLength")
    })

    it("reverts when the currency is neither empty nor 20 bytes", async function () {
      const { payloadBuilder, depository, receiver } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      await expect(
        payloadBuilder.read.buildPayload([
          "ethereum-mainnet",
          depository.account.address,
          {
            amount: 1n,
            currency: "0x1234",
            data: "0x",
            nonce: 1n,
            receiver: receiver.account.address,
          },
        ])
      ).to.be.rejectedWith("InvalidCurrencyLength")
    })
  })

  describe("hashesToSign()", function () {
    it("hashes a payload correctly using EIP-712", async function () {
      const { config, owner, payloadBuilder, depository, receiver } =
        await loadFixture(deployEthereumVmPayloadBuilder)

      const amount = parseUnits("0.1", 18)
      const chainId = "ethereum-mainnet"
      const evmChainId = 1n
      const key = await payloadBuilder.read.getEvmChainIdKey([chainId])

      await config.write.setConfigValue(
        [key, toHex(evmChainId, { size: 32 })],
        {
          account: owner.account,
        }
      )

      const payload = await payloadBuilder.read.buildPayload([
        chainId,
        depository.account.address,
        {
          amount,
          currency: zeroAddress,
          data: "0x",
          nonce: 4n,
          receiver: receiver.account.address,
        },
      ])

      const [hash] = await payloadBuilder.read.hashesToSign([
        chainId,
        depository.account.address,
        payload,
      ])

      const [message] = decodeAbiParameters(
        [
          {
            components: [
              {
                components: [
                  { name: "to", type: "address" },
                  { name: "data", type: "bytes" },
                  { name: "value", type: "uint256" },
                  { name: "allowFailure", type: "bool" },
                ],
                name: "calls",
                type: "tuple[]",
              },
              { name: "nonce", type: "uint256" },
              { name: "expiration", type: "uint256" },
            ],
            name: "callRequest",
            type: "tuple",
          },
        ],
        payload
      )

      const reconstructedHash = hashTypedData({
        domain: {
          chainId: Number(evmChainId),
          name: "RelayDepository",
          verifyingContract: depository.account.address,
          version: "1",
        },
        message,
        primaryType: "CallRequest",
        types: {
          Call: [
            { name: "to", type: "address" },
            { name: "data", type: "bytes" },
            { name: "value", type: "uint256" },
            { name: "allowFailure", type: "bool" },
          ],
          CallRequest: [
            { name: "calls", type: "Call[]" },
            { name: "nonce", type: "uint256" },
            { name: "expiration", type: "uint256" },
          ],
        },
      })

      expect(hash).to.equal(reconstructedHash)
    })

    it("uses a namespaced config key for Ethereum VM chain id lookups", async function () {
      const { payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      const chainId = "ethereum-mainnet"
      const key = await payloadBuilder.read.getEvmChainIdKey([chainId])
      const expectedKey = keccak256(
        `0x${keccak256(stringToHex("ETHEREUM_VM_CHAIN_ID")).slice(2)}${stringToHex(chainId).slice(2)}`
      )

      expect(key).to.equal(expectedKey)
    })

    it("uses a namespaced config key for Ethereum VM expiration lookups", async function () {
      const { payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      expect(await payloadBuilder.read.getExpirationKey()).to.equal(
        keccak256(stringToHex("ETHEREUM_VM_EXPIRATION"))
      )
    })

    it("reverts if the chain id is not configured", async function () {
      const { payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      const payload = encodeAbiParameters(
        parseAbiParameters(
          "((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)"
        ),
        [
          [
            [{ allowFailure: false, data: "0x", to: zeroAddress, value: 0n }],
            1n,
            2n,
          ],
        ]
      )

      await expect(
        payloadBuilder.read.hashesToSign([
          "missing-chain-id",
          "0x1111111111111111111111111111111111111111",
          payload,
        ])
      ).to.be.rejectedWith("ConfigValueNotSet")
    })

    it("reverts if the depository is not 20 bytes", async function () {
      const { config, owner, payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )

      const chainId = "ethereum-mainnet"
      const key = await payloadBuilder.read.getEvmChainIdKey([chainId])
      await config.write.setConfigValue([key, toHex(1n, { size: 32 })], {
        account: owner.account,
      })

      const payload = encodeAbiParameters(
        parseAbiParameters(
          "((address to, bytes data, uint256 value, bool allowFailure)[] calls, uint256 nonce, uint256 expiration)"
        ),
        [
          [
            [{ allowFailure: false, data: "0x", to: zeroAddress, value: 0n }],
            1n,
            2n,
          ],
        ]
      )

      await expect(
        payloadBuilder.read.hashesToSign([chainId, "0x1234", payload])
      ).to.be.rejectedWith("InvalidDepositoryLength")
    })
  })

  describe("metadata", function () {
    it("returns the expected curve", async function () {
      const { payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )
      expect(await payloadBuilder.read.curve()).to.equal("Ecdsa")
    })

    it("returns the expected family", async function () {
      const { payloadBuilder } = await loadFixture(
        deployEthereumVmPayloadBuilder
      )
      expect(await payloadBuilder.read.family()).to.equal("ethereum-vm")
    })
  })
})
