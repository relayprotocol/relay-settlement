import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { expect } from "chai"
import hre from "hardhat"
import {
  decodeAbiParameters,
  hashTypedData,
  keccak256,
  encodeAbiParameters,
  zeroAddress,
  parseUnits,
} from "viem"
import { deployAllocator } from "../../helpers/deployAllocator"

const HYPERLIQUID_TX_ABI = [
  {
    components: [
      { name: "txType", type: "uint8" },
      { name: "parameters", type: "bytes" },
    ],
    type: "tuple",
  },
]

const USD_SEND_REQUEST_ABI = [
  {
    components: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    type: "tuple",
  },
]

const SEND_ASSET_REQUEST_ABI = [
  {
    components: [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "sourceDex", type: "string" },
      { name: "destinationDex", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "fromSubAccount", type: "string" },
      { name: "nonce", type: "uint64" },
    ],
    type: "tuple",
  },
]

describe("Allocator HyperliquidPayloadBuilder", function () {
  async function deployHyperliquidPayloadBuilder() {
    const [depository, receiver] = await hre.viem.getWalletClients()

    // Deploy allocator using existing helper
    const { allocator, owner: admin } = await deployAllocator()

    const payloadBuilder = await hre.viem.deployContract(
      "HyperLiquidPayloadBuilder",
      ["Mainnet", allocator.address]
    )

    return {
      admin,
      allocator,
      depository,
      payloadBuilder,
      receiver,
    }
  }

  describe("constructor", function () {
    it("should initialize with the correct hyperliquid chain", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const hyperliquidChain = await payloadBuilder.read.hyperliquidChain()
      expect(hyperliquidChain).to.equal("Mainnet")
    })
  })

  describe("setCurrencyDecimals()", function () {
    it("should set target decimals for empty currency (USD)", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      await payloadBuilder.write.setCurrencyDecimals(["", 6], {
        account: admin.account,
      })
      const decimals = await payloadBuilder.read.currencyDecimals([""])
      expect(decimals).to.equal(6)
    })

    it("should set target decimals for spot currency", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const currency = "PURR:0xc1fb593aeffbeb02f85e0308e9956a90"
      await payloadBuilder.write.setCurrencyDecimals([currency, 8], {
        account: admin.account,
      })
      const decimals = await payloadBuilder.read.currencyDecimals([currency])
      expect(decimals).to.equal(8)
    })

    it("should revert when setting decimals > 18", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      try {
        await payloadBuilder.write.setCurrencyDecimals(["", 19], {
          account: admin.account,
        })
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidDecimals")
      }
    })

    it("should revert when non-allocator-owner tries to set decimals", async () => {
      const { payloadBuilder, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      try {
        await payloadBuilder.write.setCurrencyDecimals(["", 6], {
          account: receiver.account,
        })
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("NotRelayAllocatorOwner")
      }
    })
  })

  describe("setDexWhitelist()", function () {
    it("should allow allocator owner to set DEX whitelist", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      await payloadBuilder.write.setDexWhitelist(["testDex", true], {
        account: admin.account,
      })
      const isWhitelisted = await payloadBuilder.read.dexWhitelist(["testDex"])
      expect(isWhitelisted).to.equal(true)
    })

    it("should allow allocator owner to remove DEX from whitelist", async () => {
      const { payloadBuilder, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Add then remove
      await payloadBuilder.write.setDexWhitelist(["testDex", true], {
        account: admin.account,
      })
      await payloadBuilder.write.setDexWhitelist(["testDex", false], {
        account: admin.account,
      })
      const isWhitelisted = await payloadBuilder.read.dexWhitelist(["testDex"])
      expect(isWhitelisted).to.equal(false)
    })

    it("should revert when non-allocator-owner tries to set DEX whitelist", async () => {
      const { payloadBuilder, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      try {
        await payloadBuilder.write.setDexWhitelist(["testDex", true], {
          account: receiver.account,
        })
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("NotRelayAllocatorOwner")
      }
    })
  })

  describe("buildPayload()", function () {
    it("should build a payload for Core USD transfer using default decimals", async () => {
      const { payloadBuilder, depository, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const amount = 10000000000n // 100.00000000 with DEFAULT_USD_DECIMALS = 8
      const testTime = 1640995200000n // Fixed timestamp in milliseconds
      const testData = encodeAbiParameters([{ type: "uint64" }], [testTime])

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        depository.account.address, // depository
        "", // currency (empty for Core USD)
        amount, // amount
        receiver.account.address, // receiver
        testData, // data with timestamp only
      ])

      const [decodedPayload] = decodeAbiParameters(
        HYPERLIQUID_TX_ABI,
        payload
      ) as any[]

      // Should be UsdSend transaction type (0)
      expect(decodedPayload.txType).to.equal(0)

      // Decode the parameters as UsdSendRequest
      const [request] = decodeAbiParameters(
        USD_SEND_REQUEST_ABI,
        decodedPayload.parameters as `0x${string}`
      ) as any[]

      expect(request.hyperliquidChain).to.equal("Mainnet")
      expect(request.destination).to.equal(receiver.account.address)
      expect(request.amount).to.equal("100.00000000") // Uses DEFAULT_USD_DECIMALS = 8
      expect(request.time).to.equal(testTime)
    })

    it("should build a payload for Core USD transfer using custom decimals", async () => {
      const { payloadBuilder, depository, receiver, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Set custom decimals for USD
      await payloadBuilder.write.setCurrencyDecimals(["", 1], {
        account: admin.account,
      })

      const amount = 1000n // 100.0 with 1 decimal place
      const testTime = 1640995200000n
      const testData = encodeAbiParameters([{ type: "uint64" }], [testTime])

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        depository.account.address, // depository
        "", // currency (empty for Core USD)
        amount, // amount
        receiver.account.address, // receiver
        testData, // data with timestamp only
      ])

      const [decodedPayload] = decodeAbiParameters(
        HYPERLIQUID_TX_ABI,
        payload
      ) as any[]

      // Decode the parameters as UsdSendRequest
      const [request] = decodeAbiParameters(
        USD_SEND_REQUEST_ABI,
        decodedPayload.parameters as `0x${string}`
      ) as any[]

      expect(request.amount).to.equal("100.0") // Uses custom 1 decimal place
    })

    it("should build a payload using SendAsset with whitelisted DEXs", async () => {
      const { payloadBuilder, depository, receiver, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Whitelist the DEXs
      await payloadBuilder.write.setDexWhitelist(["dex1", true], {
        account: admin.account,
      })
      await payloadBuilder.write.setDexWhitelist(["dex2", true], {
        account: admin.account,
      })

      const amount = 5025n // 50.25 with 2 decimal places
      const currency = "PURR:0xc1fb593aeffbeb02f85e0308e9956a90"
      const testTime = 1640995200000n

      // Set target decimals for this currency
      await payloadBuilder.write.setCurrencyDecimals([currency, 2], {
        account: admin.account,
      })

      const testData = encodeAbiParameters(
        [{ type: "uint64" }, { type: "string" }, { type: "string" }],
        [testTime, "dex1", "dex2"]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        depository.account.address, // depository
        currency, // currency
        amount, // amount
        receiver.account.address, // receiver
        testData, // data with timestamp, sourceDex and destinationDex
      ])

      const [decodedPayload] = decodeAbiParameters(
        HYPERLIQUID_TX_ABI,
        payload
      ) as any[]

      // Should be SendAsset transaction type (1)
      expect(decodedPayload.txType).to.equal(1)

      // Decode the parameters as SendAssetRequest
      const [request] = decodeAbiParameters(
        SEND_ASSET_REQUEST_ABI,
        decodedPayload.parameters as `0x${string}`
      ) as any[]

      expect(request.hyperliquidChain).to.equal("Mainnet")
      expect(request.destination).to.equal(receiver.account.address)
      expect(request.sourceDex).to.equal("dex1")
      expect(request.destinationDex).to.equal("dex2")
      expect(request.token).to.equal(currency)
      expect(request.amount).to.equal("50.25") // 50.25 with 2 decimal precision
      expect(request.fromSubAccount).to.equal("")
      expect(request.nonce).to.equal(testTime)
    })

    it("should revert when using SendAsset with non-whitelisted DEXs", async () => {
      const { payloadBuilder, depository, receiver, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Only whitelist one DEX
      await payloadBuilder.write.setDexWhitelist(["dex1", true], {
        account: admin.account,
      })

      const amount = parseUnits("50.25", 18)
      const currency = "PURR:0xc1fb593aeffbeb02f85e0308e9956a90"
      const testTime = 1640995200000n

      // Set target decimals for this currency
      await payloadBuilder.write.setCurrencyDecimals([currency, 2], {
        account: admin.account,
      })

      const testData = encodeAbiParameters(
        [{ type: "uint64" }, { type: "string" }, { type: "string" }],
        [testTime, "dex1", "nonWhitelistedDex"] // destination DEX is not whitelisted
      )

      try {
        await payloadBuilder.read.buildPayload([
          1n, // chainId
          depository.account.address, // depository
          currency, // currency
          amount, // amount
          receiver.account.address, // receiver
          testData, // data with timestamp, sourceDex and destinationDex
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidDEX")
      }
    })

    it("should revert when spot currency is not configured", async () => {
      const { payloadBuilder, depository, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const amount = parseUnits("50.25", 18)
      const currency = "UNCONFIGURED:0x123"
      const testTime = 1640995200000n
      const testData = encodeAbiParameters([{ type: "uint64" }], [testTime])

      try {
        await payloadBuilder.read.buildPayload([
          1n, // chainId
          depository.account.address, // depository
          currency, // unconfigured currency
          amount, // amount
          receiver.account.address, // receiver
          testData, // data with timestamp only
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidDecimals")
      }
    })

    it("should revert with InvalidData when no data provided", async () => {
      const { payloadBuilder, depository, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const amount = 0n // Zero amount for test

      try {
        await payloadBuilder.read.buildPayload([
          1n, // chainId
          depository.account.address, // depository
          "", // currency (empty for Core USD)
          amount, // amount
          receiver.account.address, // receiver
          "0x", // empty data - should cause revert
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidData")
      }
    })
  })

  describe("hashToSign()", function () {
    it("should hash a USD transfer payload correctly using EIP712", async () => {
      const { payloadBuilder, depository, receiver } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const amount = 105000000n // 1.05000000 with DEFAULT_USD_DECIMALS = 8
      const chainId = 1n
      const testTime = 1640995200000n
      const testData = encodeAbiParameters([{ type: "uint64" }], [testTime])

      const payload = await payloadBuilder.read.buildPayload([
        chainId, // chainId
        depository.account.address, // depository
        "", // currency (empty for Core USD)
        amount, // amount
        receiver.account.address, // receiver
        testData, // data with timestamp only
      ])

      const hash = (await payloadBuilder.read.hashToSign([
        chainId, // chainId
        depository.account.address, // depository
        payload,
        0, // hashIndex (not used in current implementation)
      ])) as `0x${string}`[]

      // Reconstruct the EIP712 hash manually
      const reconstructedHash = hashTypedData({
        domain: {
          chainId: Number(chainId),
          name: "HyperliquidSignTransaction",
          verifyingContract: zeroAddress,
          version: "1",
        },
        message: {
          amount: "1.05000000", // Uses DEFAULT_USD_DECIMALS = 8
          destination: receiver.account.address,
          hyperliquidChain: "Mainnet",
          time: testTime,
        },
        primaryType: "HyperliquidTransaction:UsdSend",
        types: {
          "HyperliquidTransaction:UsdSend": [
            { name: "hyperliquidChain", type: "string" },
            { name: "destination", type: "string" },
            { name: "amount", type: "string" },
            { name: "time", type: "uint64" },
          ],
        },
      })

      expect(hash).to.equal(reconstructedHash)
    })

    it("should hash a SendAsset transfer payload correctly using EIP712", async () => {
      const { payloadBuilder, depository, receiver, admin } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const amount = 275n // 2.75 with 2 decimal places
      const chainId = 1n
      const currency = "PURR:0xc1fb593aeffbeb02f85e0308e9956a90"
      const testTime = 1640995200000n

      // Whitelist the DEXs
      await payloadBuilder.write.setDexWhitelist(["dex1", true], {
        account: admin.account,
      })
      await payloadBuilder.write.setDexWhitelist(["dex2", true], {
        account: admin.account,
      })

      // Set target decimals for this currency
      await payloadBuilder.write.setCurrencyDecimals([currency, 2], {
        account: admin.account,
      })

      const testData = encodeAbiParameters(
        [{ type: "uint64" }, { type: "string" }, { type: "string" }],
        [testTime, "dex1", "dex2"]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId
        depository.account.address, // depository
        currency, // currency
        amount, // amount
        receiver.account.address, // receiver
        testData, // data with timestamp, sourceDex and destinationDex
      ])

      const hash = (await payloadBuilder.read.hashToSign([
        chainId, // chainId
        depository.account.address, // depository
        payload,
        0, // hashIndex (not used in current implementation
      ])) as `0x${string}`[]

      // Reconstruct the EIP712 hash manually
      const reconstructedHash = hashTypedData({
        domain: {
          chainId: Number(chainId),
          name: "HyperliquidSignTransaction",
          verifyingContract: zeroAddress,
          version: "1",
        },
        message: {
          amount: "2.75",
          destination: receiver.account.address,
          destinationDex: "dex2",
          fromSubAccount: "",
          hyperliquidChain: "Mainnet",
          nonce: testTime,
          sourceDex: "dex1",
          token: currency,
        },
        primaryType: "HyperliquidTransaction:SendAsset",
        types: {
          "HyperliquidTransaction:SendAsset": [
            { name: "hyperliquidChain", type: "string" },
            { name: "destination", type: "string" },
            { name: "sourceDex", type: "string" },
            { name: "destinationDex", type: "string" },
            { name: "token", type: "string" },
            { name: "amount", type: "string" },
            { name: "fromSubAccount", type: "string" },
            { name: "nonce", type: "uint64" },
          ],
        },
      })

      expect(hash).to.equal(reconstructedHash)
    })

    it("should revert with InvalidTransactionType for unknown transaction type", async () => {
      const { payloadBuilder, depository } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Create a malformed payload with invalid transaction type
      const invalidPayload = encodeAbiParameters(HYPERLIQUID_TX_ABI, [
        {
          // Invalid transaction type
          parameters: "0x",
          txType: 99,
        },
      ])

      try {
        await payloadBuilder.read.hashToSign([
          1n, // chainId
          depository.account.address, // depository
          invalidPayload,
          0, // hashIndex (not used in current implementation
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("revert")
      }
    })
  })

  describe("curve()", function () {
    it('should return "Ecdsa"', async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const curve = await payloadBuilder.read.curve()
      expect(curve).to.equal("Ecdsa")
    })
  })

  describe("family()", function () {
    it('should return "hyperliquid-vm"', async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const family = await payloadBuilder.read.family()
      expect(family).to.equal("hyperliquid-vm")
    })
  })

  describe("toDecimalString()", function () {
    it("should convert basic amounts correctly", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test 1000 with 1 decimal place (100.0)
      expect(await payloadBuilder.read.toDecimalString([1000n, 1])).to.equal(
        "100.0"
      )

      // Test 5025 with 2 decimal places (50.25)
      expect(await payloadBuilder.read.toDecimalString([5025n, 2])).to.equal(
        "50.25"
      )

      // Test 105 with 2 decimal places (1.05)
      expect(await payloadBuilder.read.toDecimalString([105n, 2])).to.equal(
        "1.05"
      )

      // Test 100000000 with 8 decimal places (1.00000000) - your example
      expect(
        await payloadBuilder.read.toDecimalString([100000000n, 8])
      ).to.equal("1.00000000")
    })

    it("should handle zero amounts", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test 0 with various decimal places
      expect(await payloadBuilder.read.toDecimalString([0n, 1])).to.equal("0.0")
      expect(await payloadBuilder.read.toDecimalString([0n, 2])).to.equal(
        "0.00"
      )
      expect(await payloadBuilder.read.toDecimalString([0n, 6])).to.equal(
        "0.000000"
      )
    })

    it("should handle integer amounts (decimals = 0)", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test integer conversion (no decimals)
      expect(await payloadBuilder.read.toDecimalString([100n, 0])).to.equal(
        "100"
      )
      expect(await payloadBuilder.read.toDecimalString([42n, 0])).to.equal("42")
      expect(await payloadBuilder.read.toDecimalString([1000n, 0])).to.equal(
        "1000"
      )
    })

    it("should handle small amounts with leading zeros", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test amounts with leading zeros in fractional part
      expect(
        await payloadBuilder.read.toDecimalString([1n, 2]) // 0.01
      ).to.equal("0.01")
      expect(
        await payloadBuilder.read.toDecimalString([
          1n,
          3, // 0.001
        ])
      ).to.equal("0.001")
      expect(
        await payloadBuilder.read.toDecimalString([
          1n,
          4, // 0.0001
        ])
      ).to.equal("0.0001")
    })

    it("should handle maximum precision (18 decimals)", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test with maximum 18 decimal places
      const maxPrecisionAmount = 1123456789012345678n // 1.123456789012345678
      expect(
        await payloadBuilder.read.toDecimalString([maxPrecisionAmount, 18])
      ).to.equal("1.123456789012345678")
    })

    it("should preserve decimal format with trailing zeros", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test decimal format preservation
      expect(
        await payloadBuilder.read.toDecimalString([
          100000n, // 100.000 with 3 decimals
          3,
        ])
      ).to.equal("100.000")
      expect(
        await payloadBuilder.read.toDecimalString([425000n, 4]) // 42.5000 with 4 decimals
      ).to.equal("42.5000")
      expect(
        await payloadBuilder.read.toDecimalString([100000n, 6]) // 0.100000 with 6 decimals
      ).to.equal("0.100000")
    })

    it("should revert with InvalidDecimals for decimals > 18", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      try {
        await payloadBuilder.read.toDecimalString([100n, 19])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidDecimals")
      }
    })

    it("should handle any raw amount without precision errors", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test any raw amount - no more strict precision checking
      expect(
        await payloadBuilder.read.toDecimalString([112345n, 5]) // 1.12345
      ).to.equal("1.12345")

      expect(
        await payloadBuilder.read.toDecimalString([112345n, 2]) // 1123.45
      ).to.equal("1123.45")
    })

    it("should handle edge cases", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      // Test very large numbers
      const largeAmount = 999999999999123456n // 999999999999.123456 with 6 decimals
      expect(
        await payloadBuilder.read.toDecimalString([largeAmount, 6])
      ).to.equal("999999999999.123456")

      // Test smallest unit with 18 decimals
      expect(await payloadBuilder.read.toDecimalString([1n, 18])).to.equal(
        "0.000000000000000001"
      )
    })
  })

  describe("constants", function () {
    it("should have correct EIP712 constants", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const domainName = await payloadBuilder.read.EIP712_DOMAIN_NAME()
      const domainVersion = await payloadBuilder.read.EIP712_DOMAIN_VERSION()

      expect(domainName).to.equal("HyperliquidSignTransaction")
      expect(domainVersion).to.equal("1")
    })

    it("should have correct type hashes", async () => {
      const { payloadBuilder } = await loadFixture(
        deployHyperliquidPayloadBuilder
      )

      const usdSendTypeHash = await payloadBuilder.read.USD_SEND_TYPEHASH()
      const sendAssetTypeHash = await payloadBuilder.read.SEND_ASSET_TYPEHASH()

      const expectedUsdSendTypeHash = keccak256(
        Buffer.from(
          "HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)"
        )
      )
      const expectedSendAssetTypeHash = keccak256(
        Buffer.from(
          "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)"
        )
      )

      expect(usdSendTypeHash).to.equal(expectedUsdSendTypeHash)
      expect(sendAssetTypeHash).to.equal(expectedSendAssetTypeHash)
    })
  })
})
