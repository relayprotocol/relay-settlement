import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import bs58 from "bs58"
import hre from "hardhat"
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toHex,
} from "viem"
import { decodeDepositoryRequest, hashRequest } from "../../lib/solana"

const CHAIN_ID = "solana-mainnet"
const DOMAIN = keccak256("0x01")
const EXPIRATION_DELAY_SECONDS = 300n
const EXPIRATION_TOLERANCE_SECONDS = 10n
const VAULT_ADDRESS = bs58.decode(
  "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
)
const UINT64_MASK = (1n << 64n) - 1n

const encodeSolanaAddress = (address: string) => toHex(bs58.decode(address))

const deriveNonce = (
  blockNumber: bigint,
  nonce: bigint,
  currency: `0x${string}`,
  receiver: `0x${string}`,
  data: `0x${string}`,
  amount: bigint
) =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "uint256 blockNumber, uint256 nonce, bytes currency, bytes receiver, bytes data, uint256 amount"
        ),
        [blockNumber, nonce, currency, receiver, data, amount]
      )
    )
  ) & UINT64_MASK

async function deploySolanaVmPayloadBuilder() {
  const [owner, ...otherAccounts] = await hre.viem.getWalletClients()
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
    "SolanaVmPayloadBuilder",
    [config.address]
  )

  const domainKey = await payloadBuilder.read.getDomainKey([CHAIN_ID])
  const vaultAddressKey = await payloadBuilder.read.getVaultAddressKey([
    CHAIN_ID,
  ])
  const expirationKey = await payloadBuilder.read.getExpirationKey()
  await config.write.setConfigValues(
    [
      [domainKey, vaultAddressKey, expirationKey],
      [
        DOMAIN,
        toHex(VAULT_ADDRESS, { size: 32 }),
        toHex(EXPIRATION_DELAY_SECONDS, { size: 32 }),
      ],
    ],
    { account: owner.account }
  )

  const [depository, receiver] = otherAccounts

  return {
    config,
    depository,
    owner,
    payloadBuilder,
    publicClient,
    receiver,
  }
}

describe("SolanaVmPayloadBuilder", function () {
  describe("config keys", function () {
    it("derives a namespaced domain key", async function () {
      const { payloadBuilder } = await loadFixture(deploySolanaVmPayloadBuilder)
      const key = await payloadBuilder.read.getDomainKey([CHAIN_ID])
      const expectedKey = keccak256(
        `0x${keccak256(stringToHex("SOLANA_VM_DOMAIN")).slice(2)}${stringToHex(CHAIN_ID).slice(2)}`
      )

      expect(key).to.equal(expectedKey)
    })

    it("derives a namespaced vault address key", async function () {
      const { payloadBuilder } = await loadFixture(deploySolanaVmPayloadBuilder)
      const key = await payloadBuilder.read.getVaultAddressKey([CHAIN_ID])
      const expectedKey = keccak256(
        `0x${keccak256(stringToHex("SOLANA_VM_VAULT_ADDRESS")).slice(2)}${stringToHex(CHAIN_ID).slice(2)}`
      )

      expect(key).to.equal(expectedKey)
    })

    it("derives a namespaced expiration key", async function () {
      const { payloadBuilder } = await loadFixture(deploySolanaVmPayloadBuilder)
      expect(await payloadBuilder.read.getExpirationKey()).to.equal(
        keccak256(stringToHex("SOLANA_VM_EXPIRATION"))
      )
    })
  })

  describe("buildPayload()", function () {
    it("rejects an unconfigured chain id", async function () {
      const { depository, payloadBuilder } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      await expect(
        payloadBuilder.read.buildPayload([
          "missing-chain",
          depository.account.address,
          {
            amount: 100000000n,
            currency: "0x",
            data: "0x",
            nonce: 0n,
            receiver: encodeSolanaAddress(
              "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
            ),
          },
        ])
      ).to.be.rejectedWith("ConfigValueNotSet")
    })

    it("builds a payload when using SOL", async function () {
      const { depository, payloadBuilder, publicClient } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const latestBlock = await publicClient.getBlock()
      const payload = await payloadBuilder.read.buildPayload(
        [
          CHAIN_ID,
          depository.account.address,
          {
            amount: 100000000n,
            currency: "0x",
            data: "0x",
            nonce: 1749095710252n,
            receiver: encodeSolanaAddress(
              "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
            ),
          },
        ],
        { account: depository.account.address }
      )

      const decodedRequest = decodeDepositoryRequest(payload)
      const now = latestBlock.number >= 0n ? latestBlock.timestamp : 0n
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toBase58()).to.equal(
        "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
      )
      expect(decodedRequest.token).to.equal(null)
      expect(decodedRequest.amount.toString()).to.equal("100000000")
      expect(decodedRequest.nonce.toString()).to.equal(
        deriveNonce(
          latestBlock.number,
          1749095710252n,
          "0x",
          encodeSolanaAddress("38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"),
          "0x",
          100000000n
        ).toString()
      )
      expect(
        BigInt(decodedRequest.expiration.toString()) >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        BigInt(decodedRequest.expiration.toString()) <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
    })

    it("builds a payload when using an SPL token", async function () {
      const { depository, payloadBuilder, publicClient } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const latestBlock = await publicClient.getBlock()
      const payload = await payloadBuilder.read.buildPayload(
        [
          CHAIN_ID,
          depository.account.address,
          {
            amount: 100000000n,
            currency: encodeSolanaAddress(
              "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
            ),
            data: "0x",
            nonce: 1749095749158n,
            receiver: encodeSolanaAddress(
              "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"
            ),
          },
        ],
        { account: depository.account.address }
      )

      const decodedRequest = decodeDepositoryRequest(payload)
      const now = latestBlock.number >= 0n ? latestBlock.timestamp : 0n
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toBase58()).to.equal(
        "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"
      )
      expect(decodedRequest.token?.toBase58()).to.equal(
        "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      )
      expect(decodedRequest.amount.toString()).to.equal("100000000")
      expect(decodedRequest.nonce.toString()).to.equal(
        deriveNonce(
          latestBlock.number,
          1749095749158n,
          encodeSolanaAddress("5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"),
          encodeSolanaAddress("FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"),
          "0x",
          100000000n
        ).toString()
      )
      expect(
        BigInt(decodedRequest.expiration.toString()) >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        BigInt(decodedRequest.expiration.toString()) <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
    })

    it("uses the configured expiration delay when metadata is omitted", async function () {
      const { depository, payloadBuilder, publicClient } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const latestBlock = await publicClient.getBlock()
      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID,
        depository.account.address,
        {
          amount: 1n,
          currency: "0x",
          data: "0x",
          nonce: 9n,
          receiver: encodeSolanaAddress(
            "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
          ),
        },
      ])

      const decodedRequest = decodeDepositoryRequest(payload)
      const now = latestBlock.number >= 0n ? latestBlock.timestamp : 0n
      expect(
        BigInt(decodedRequest.expiration.toString()) >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        BigInt(decodedRequest.expiration.toString()) <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
    })

    it("rejects a receiver with invalid encoded length", async function () {
      const { depository, payloadBuilder } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      await expect(
        payloadBuilder.read.buildPayload([
          CHAIN_ID,
          depository.account.address,
          {
            amount: 1n,
            currency: "0x",
            data: "0x",
            nonce: 0n,
            receiver: "0x1234",
          },
        ])
      ).to.be.rejectedWith("InvalidAddressLength")
    })

    it("rejects a token with invalid encoded length", async function () {
      const { depository, payloadBuilder } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      await expect(
        payloadBuilder.read.buildPayload([
          CHAIN_ID,
          depository.account.address,
          {
            amount: 1n,
            currency: "0x1234",
            data: "0x",
            nonce: 0n,
            receiver: encodeSolanaAddress(
              "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
            ),
          },
        ])
      ).to.be.rejectedWith("InvalidAddressLength")
    })
  })

  describe("hashesToSign()", function () {
    it("hashes a payload correctly using SHA-256", async function () {
      const { depository, payloadBuilder } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID,
        depository.account.address,
        {
          amount: 100000000n,
          currency: "0x",
          data: "0x",
          nonce: 1749095710252n,
          receiver: encodeSolanaAddress(
            "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
          ),
        },
      ])

      const hashes = await payloadBuilder.read.hashesToSign([
        CHAIN_ID,
        depository.account.address,
        payload,
      ])

      const expectedHash = hashRequest(decodeDepositoryRequest(payload)).hash
      expect(hashes).to.deep.equal([expectedHash])
    })
  })

  describe("payload decoding", function () {
    it("decodes a native SOL transfer request", async function () {
      const { depository, payloadBuilder, publicClient } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const nonce = 1749095710252n
      const recipient = "ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm"
      const latestBlock = await publicClient.getBlock()

      const payload = await payloadBuilder.read.buildPayload(
        [
          CHAIN_ID,
          depository.account.address,
          {
            amount: 1n,
            currency: "0x",
            data: "0x",
            nonce,
            receiver: encodeSolanaAddress(recipient),
          },
        ],
        { account: depository.account.address }
      )

      const decodedRequest = decodeDepositoryRequest(payload)
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toBase58()).to.equal(recipient)
      expect(decodedRequest.token).to.equal(null)
      expect(decodedRequest.amount.toString()).to.equal("1")
      expect(decodedRequest.nonce.toString()).to.equal(
        deriveNonce(
          latestBlock.number,
          nonce,
          "0x",
          encodeSolanaAddress(recipient),
          "0x",
          1n
        ).toString()
      )
      const now = latestBlock.number >= 0n ? latestBlock.timestamp : 0n
      expect(
        BigInt(decodedRequest.expiration.toString()) >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        BigInt(decodedRequest.expiration.toString()) <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(decodedRequest.vaultAddress.toBase58()).to.equal(
        "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
      )
    })

    it("decodes an SPL token transfer request", async function () {
      const { depository, payloadBuilder, publicClient } = await loadFixture(
        deploySolanaVmPayloadBuilder
      )

      const nonce = 1749095710252n
      const recipient = "ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm"
      const token = "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      const latestBlock = await publicClient.getBlock()

      const payload = await payloadBuilder.read.buildPayload(
        [
          CHAIN_ID,
          depository.account.address,
          {
            amount: 1n,
            currency: encodeSolanaAddress(token),
            data: "0x",
            nonce,
            receiver: encodeSolanaAddress(recipient),
          },
        ],
        { account: depository.account.address }
      )

      const decodedRequest = decodeDepositoryRequest(payload)
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toBase58()).to.equal(recipient)
      expect(decodedRequest.token?.toBase58()).to.equal(token)
      expect(decodedRequest.amount.toString()).to.equal("1")
      expect(decodedRequest.nonce.toString()).to.equal(
        deriveNonce(
          latestBlock.number,
          nonce,
          encodeSolanaAddress(token),
          encodeSolanaAddress(recipient),
          "0x",
          1n
        ).toString()
      )
      const now = latestBlock.number >= 0n ? latestBlock.timestamp : 0n
      expect(
        BigInt(decodedRequest.expiration.toString()) >=
          now + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(
        BigInt(decodedRequest.expiration.toString()) <=
          now + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
      ).to.equal(true)
      expect(decodedRequest.vaultAddress.toBase58()).to.equal(
        "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
      )
    })
  })

  describe("metadata", function () {
    it("returns the expected curve", async function () {
      const { payloadBuilder } = await loadFixture(deploySolanaVmPayloadBuilder)
      expect(await payloadBuilder.read.curve()).to.equal("Eddsa")
    })

    it("returns the expected family", async function () {
      const { payloadBuilder } = await loadFixture(deploySolanaVmPayloadBuilder)
      expect(await payloadBuilder.read.family()).to.equal("solana-vm")
    })
  })
})
