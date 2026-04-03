import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import { keccak256, encodePacked, toHex } from "viem"
import {
  getWithdrawalAddress,
  getWithdrawalAddressSafe,
  encodeAddress,
} from "@relay-protocol/settlement-sdk"

/**
 * Unit tests for Utils.computeWithdrawalAddress (V1, encodePacked) and
 * Utils.computeWithdrawalAddressSafe (V2, abi.encode + data field)
 */
describe("Utils computeWithdrawalAddress", function () {
  async function deployUtils() {
    const utils = await hre.viem.deployContract("Utils")
    return { utils }
  }

  describe("V1 — computeWithdrawalAddress (encodePacked, no data)", function () {
    it("should match SDK getWithdrawalAddress for EVM addresses", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "0x1234567890123456789012345678901234567890"
      const depositoryChainId = "1"
      const currency = "0x0000000000000000000000000000000000000000"
      const recipientAddress =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawerAlias = recipientAddress
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["test-nonce"])
      ) as `0x${string}`

      // SDK computation (V1)
      const sdkWithdrawalAddress = getWithdrawalAddress({
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "ethereum-vm",
      })

      // Contract computation (V1 — 6 args, no data)
      const depositoryBytes = toHex(
        encodeAddress(depository, "ethereum-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "ethereum-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "ethereum-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddress([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Solana address inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
      const depositoryChainId = "1399811149"
      const currency = "11111111111111111111111111111111"
      const recipientAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
      const withdrawerAlias =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["solana-test-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddress({
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "solana-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "solana-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "solana-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "solana-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddress([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })
  })

  describe("V2 — computeWithdrawalAddressSafe (abi.encode + data)", function () {
    it("should match SDK getWithdrawalAddressSafe for EVM addresses", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "0x1234567890123456789012345678901234567890"
      const depositoryChainId = "1"
      const currency = "0x0000000000000000000000000000000000000000"
      const recipientAddress =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawerAlias = recipientAddress
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["test-nonce"])
      ) as `0x${string}`

      // SDK computation (V2)
      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "ethereum-vm",
      })

      // Contract computation (V2 — 7 args, with data)
      const depositoryBytes = toHex(
        encodeAddress(depository, "ethereum-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "ethereum-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "ethereum-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for different EVM parameter values", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "0xDeaDbeeF01234567890123456789012345678901"
      const depositoryChainId = "137"
      const currency = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" // USDC on Polygon
      const recipientAddress =
        "0x1111111111111111111111111111111111111111" as `0x${string}`
      const withdrawerAlias =
        "0x2222222222222222222222222222222222222222" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(
          ["bytes32", "uint256", "string"],
          [
            "0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            42n,
            "depositor",
          ]
        )
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "ethereum-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "ethereum-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "ethereum-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "ethereum-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Solana address inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
      const depositoryChainId = "1399811149"
      const currency = "11111111111111111111111111111111"
      const recipientAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
      const withdrawerAlias =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["solana-test-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "solana-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "solana-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "solana-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "solana-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Solana SPL token", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"
      const depositoryChainId = "1399811149"
      const currency = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      const recipientAddress = "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"
      const withdrawerAlias =
        "0x1111111111111111111111111111111111111111" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["solana-spl-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "solana-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "solana-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "solana-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "solana-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Bitcoin bech32 address inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
      const depositoryChainId = "0"
      const currency = "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8"
      const recipientAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
      const withdrawerAlias =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["bitcoin-test-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "bitcoin-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "bitcoin-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "bitcoin-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "bitcoin-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Tron address inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW"
      const depositoryChainId = "728126428"
      const currency = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
      const recipientAddress = "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW"
      const withdrawerAlias =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["tron-test-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "tron-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "tron-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "tron-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "tron-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should match SDK for Hyperliquid address inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "0x1234567890123456789012345678901234567890"
      const depositoryChainId = "998"
      const currency = "0x00000000000000000000000000000000"
      const recipientAddress = "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25"
      const withdrawerAlias =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["hyperliquid-test-nonce"])
      ) as `0x${string}`

      const sdkWithdrawalAddress = getWithdrawalAddressSafe({
        additionalData: "0x",
        chainId: depositoryChainId,
        currency: currency,
        depository: depository,
        nonce: withdrawalNonce,
        ownerAlias: withdrawerAlias,
        recipient: recipientAddress,
        vmType: "hyperliquid-vm",
      })

      const depositoryBytes = toHex(
        encodeAddress(depository, "hyperliquid-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "hyperliquid-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "hyperliquid-vm")
      ) as `0x${string}`

      const contractWithdrawalAddress =
        await utils.read.computeWithdrawalAddressSafe([
          depositoryChainId,
          depositoryBytes,
          currencyBytes,
          recipientBytes,
          withdrawerAlias,
          withdrawalNonce,
          "0x",
        ])

      expect(sdkWithdrawalAddress.toLowerCase()).to.equal(
        contractWithdrawalAddress.toLowerCase()
      )
    })

    it("should produce different addresses than V1 for the same inputs", async function () {
      const { utils } = await loadFixture(deployUtils)

      const depository = "0x1234567890123456789012345678901234567890"
      const depositoryChainId = "1"
      const currency = "0x0000000000000000000000000000000000000000"
      const recipientAddress =
        "0xAD8ed3fF56cc4c09B9BB12EdC435d40c8F285a25" as `0x${string}`
      const withdrawerAlias = recipientAddress
      const withdrawalNonce = keccak256(
        encodePacked(["string"], ["test-nonce"])
      ) as `0x${string}`

      const depositoryBytes = toHex(
        encodeAddress(depository, "ethereum-vm")
      ) as `0x${string}`
      const currencyBytes = toHex(
        encodeAddress(currency, "ethereum-vm")
      ) as `0x${string}`
      const recipientBytes = toHex(
        encodeAddress(recipientAddress, "ethereum-vm")
      ) as `0x${string}`

      const v1Address = await utils.read.computeWithdrawalAddress([
        depositoryChainId,
        depositoryBytes,
        currencyBytes,
        recipientBytes,
        withdrawerAlias,
        withdrawalNonce,
      ])

      const v2Address = await utils.read.computeWithdrawalAddressSafe([
        depositoryChainId,
        depositoryBytes,
        currencyBytes,
        recipientBytes,
        withdrawerAlias,
        withdrawalNonce,
        "0x",
      ])

      expect(v1Address.toLowerCase()).to.not.equal(v2Address.toLowerCase())
    })
  })
})
