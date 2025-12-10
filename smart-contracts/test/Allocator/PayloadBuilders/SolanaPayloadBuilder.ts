import { BN } from "@coral-xyz/anchor"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers"
import { PublicKey } from "@solana/web3.js"
import { expect } from "chai"
import hre from "hardhat"

import { encodeAbiParameters, keccak256 } from "viem"
import {
  base58ToBytes32,
  decodeDepositoryRequest,
  hashRequest,
} from "../../../lib/solana"
import { deployAllocator as deployAllocatorHelper } from "../../helpers/deployAllocator"

describe("Allocator SolanaPayloadBuilder", function () {
  const CHAIN_ID = 1n
  const DOMAIN = keccak256("0x01") // Mock domain separator
  const VAULT_ADDRESS = base58ToBytes32(
    "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
  )

  async function deployPayloadBuilder() {
    const publicClient = await hre.viem.getPublicClient()

    // Deploy allocator using existing helper
    const { allocator, owner, otherAccounts } = await deployAllocatorHelper()

    // Deploy SolanaPayloadBuilder with allocator
    const payloadBuilder = await hre.viem.deployContract(
      "SolanaPayloadBuilder",
      [allocator.address]
    )

    // Set chain configuration
    await payloadBuilder.write.setChainConfig(
      [CHAIN_ID, DOMAIN, VAULT_ADDRESS],
      { account: owner.account }
    )

    const [depository, receiver] = otherAccounts

    return {
      allocator,
      depository,
      owner,
      payloadBuilder,
      publicClient,
      receiver,
    }
  }

  describe("setChainConfig()", function () {
    it("should allow owner to set chain configuration", async () => {
      const { payloadBuilder, owner } = await loadFixture(deployPayloadBuilder)

      const newChainId = 999n
      const newDomain = keccak256("0x02")
      const newVaultAddress = base58ToBytes32(
        "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"
      )

      await payloadBuilder.write.setChainConfig(
        [newChainId, newDomain, newVaultAddress],
        { account: owner.account }
      )

      const config = await payloadBuilder.read.chainConfigs([newChainId])
      expect(config[0]).to.equal(newDomain) // domain
      expect(config[1]).to.equal(newVaultAddress) // vaultAddress
    })

    it("should reject non-owner from setting chain configuration", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      const newChainId = 999n
      const newDomain = keccak256("0x02")
      const newVaultAddress = base58ToBytes32(
        "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      )

      try {
        await payloadBuilder.write.setChainConfig(
          [newChainId, newDomain, newVaultAddress],
          { account: depository.account }
        )
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("NotRelayAllocatorOwner")
      }
    })

    it("should support multiple chainId configurations independently", async () => {
      const { payloadBuilder, owner } = await loadFixture(deployPayloadBuilder)

      const chainId1 = 100n
      const domain1 = keccak256("0x0a")
      const vaultAddress1 = base58ToBytes32(
        "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      )

      const chainId2 = 200n
      const domain2 = keccak256("0x0b")
      const vaultAddress2 = base58ToBytes32(
        "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      )

      // Set config for chain 1
      await payloadBuilder.write.setChainConfig(
        [chainId1, domain1, vaultAddress1],
        { account: owner.account }
      )

      // Set config for chain 2
      await payloadBuilder.write.setChainConfig(
        [chainId2, domain2, vaultAddress2],
        { account: owner.account }
      )

      // Verify chain 1 config
      const config1 = await payloadBuilder.read.chainConfigs([chainId1])
      expect(config1[0]).to.equal(domain1)
      expect(config1[1]).to.equal(vaultAddress1)

      // Verify chain 2 config
      const config2 = await payloadBuilder.read.chainConfigs([chainId2])
      expect(config2[0]).to.equal(domain2)
      expect(config2[1]).to.equal(vaultAddress2)
    })
  })

  describe("buildPayload()", function () {
    it("should reject unconfigured chainId", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      const unconfiguredChainId = 9999n

      try {
        await payloadBuilder.read.buildPayload([
          unconfiguredChainId,
          depository.account.address,
          "",
          100000000n,
          base58ToBytes32("38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"),
          "0x",
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("ChainNotConfigured")
      }
    })

    it("should build a payload when using SOL (native currency)", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)
      // Use future timestamp for expiration
      const currentTime = Math.floor(Date.now() / 1000)
      const futureExpiration = currentTime + 300 // 5 minutes from now

      const transferRequest = {
        amount: new BN(100000000),
        domain: Buffer.from(DOMAIN.slice(2), "hex"),
        expiration: new BN(futureExpiration),
        nonce: new BN(1749095710252),
        recipient: new PublicKey(
          "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
        ),
        token: null,
        vaultAddress: new PublicKey(Buffer.from(VAULT_ADDRESS.slice(2), "hex")),
      }

      const { bytes } = hashRequest(transferRequest)

      // Test data from the new example
      const amount = 100000000n
      const receiverBase58 = "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
      // Convert base58 to bytes32
      const receiverHex = base58ToBytes32(receiverBase58)

      // Encode nonce and expiration in data parameter
      const nonce = 1749095710252n // From test data
      const expiration = BigInt(futureExpiration) // Use future timestamp
      const data = encodeAbiParameters(
        [{ type: "uint64" }, { type: "int64" }],
        [nonce, expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID, // chainId (used to get config)
        depository.account.address, // depository (unused)
        "", // currency (empty string for SOL)
        amount,
        receiverHex,
        data,
      ])

      expect(payload).to.equal(bytes)
    })

    it("should build a payload when using an SPL token", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)
      // Use future timestamp for expiration
      const currentTime2 = Math.floor(Date.now() / 1000)
      const futureExpiration2 = currentTime2 + 300 // 5 minutes from now

      const transferRequest = {
        amount: new BN(100000000),
        domain: Buffer.from(DOMAIN.slice(2), "hex"),
        expiration: new BN(futureExpiration2),
        nonce: new BN(1749095749158),
        recipient: new PublicKey(
          "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"
        ),
        token: new PublicKey("5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"),
        vaultAddress: new PublicKey(Buffer.from(VAULT_ADDRESS.slice(2), "hex")),
      }

      const { bytes } = hashRequest(transferRequest)
      const amount = 100000000n
      const receiverBase58 = "FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD"
      const tokenBase58 = "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"

      const receiverHex = base58ToBytes32(receiverBase58)
      const tokenHex = base58ToBytes32(tokenBase58)

      // Use same nonce and expiration as native test for consistency
      const nonce = 1749095749158n
      const expiration = BigInt(futureExpiration2)
      const data = encodeAbiParameters(
        [{ type: "uint64" }, { type: "int64" }],
        [nonce, expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID,
        depository.account.address,
        tokenHex,
        amount,
        receiverHex,
        data,
      ])

      expect(payload).to.be.a("string")
      expect(payload.startsWith("0x")).to.equal(true)
      expect(payload.length).to.be.greaterThan(2)
      expect(payload).to.equal(bytes)
    })

    it("should reject expired timestamp", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      const pastExpiration = Math.floor(Date.now() / 1000) - 300 // 5 minutes ago
      const nonce = 1749095710252n

      const data = encodeAbiParameters(
        [{ type: "uint64" }, { type: "int64" }],
        [nonce, BigInt(pastExpiration)]
      )

      // Should revert with InvalidExpiration error
      try {
        await payloadBuilder.read.buildPayload([
          CHAIN_ID,
          depository.account.address,
          "",
          100000000n,
          base58ToBytes32("38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"),
          data,
        ])
        expect.fail("Expected transaction to revert")
      } catch (error: any) {
        expect(error.message).to.include("InvalidExpiration")
      }
    })
  })

  describe("hashToSign()", function () {
    it("should hash a payload correctly using SHA-256", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      // Use the new test data payload - need to update with domain and vaultAddress
      const currentTime = Math.floor(Date.now() / 1000)
      const futureExpiration = currentTime + 300

      const transferRequest = {
        amount: new BN(100000000),
        domain: Buffer.from(DOMAIN.slice(2), "hex"),
        expiration: new BN(futureExpiration),
        nonce: new BN(1749095710252),
        recipient: new PublicKey(
          "38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH"
        ),
        token: null,
        vaultAddress: new PublicKey(Buffer.from(VAULT_ADDRESS.slice(2), "hex")),
      }

      const { bytes: payload, hash: expectedHash } =
        hashRequest(transferRequest)

      const hash = await payloadBuilder.read.hashToSign([
        CHAIN_ID, // chainId (unused)
        depository.account.address, // depository (unused)
        payload,
        0, // Solana only requires a single hash
      ])

      expect(hash).to.equal(expectedHash)
    })
  })

  describe("decodeDepositoryRequest", function () {
    const amount = 1n
    const currentTime = Math.floor(Date.now() / 1000)
    const expiration = BigInt(currentTime + 300) // 5 minutes from now
    const nonce = 1749095710252n
    const recipient = "ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm"

    it("should correctly decode a native SOL transfer request", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      // Create a test transfer request
      const transferRequest = {
        amount: new BN(amount.toString()),
        domain: Buffer.from(DOMAIN.slice(2), "hex"),
        expiration: new BN(expiration.toString()),
        nonce: new BN(nonce.toString()),
        recipient: new PublicKey(recipient),
        token: null,
        vaultAddress: new PublicKey(Buffer.from(VAULT_ADDRESS.slice(2), "hex")),
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID, // chainId (used to get config)
        depository.account.address, // depository (unused)
        "", // currency (empty string for SOL)
        amount, // amount
        base58ToBytes32(recipient), // receiver
        encodeAbiParameters(
          [{ type: "uint64" }, { type: "int64" }],
          [nonce, expiration]
        ), // data (nonce and expiration)
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeDepositoryRequest(payload)

      // Compare the decoded values with the original request
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toBase58()).to.equal(
        transferRequest.recipient.toBase58()
      )
      expect(decodedRequest.token).to.equal(null)
      expect(decodedRequest.amount.toString()).to.equal(
        transferRequest.amount.toString()
      )
      expect(decodedRequest.nonce.toString()).to.equal(
        transferRequest.nonce.toString()
      )
      expect(decodedRequest.expiration.toString()).to.equal(
        transferRequest.expiration.toString()
      )
      expect(decodedRequest.vaultAddress.toBase58()).to.equal(
        transferRequest.vaultAddress.toBase58()
      )
    })

    it("should correctly decode an SPL token transfer request", async () => {
      const { payloadBuilder, depository } =
        await loadFixture(deployPayloadBuilder)

      const token = "5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE"
      // Create a test transfer request with an SPL token
      const transferRequest = {
        amount: new BN(amount.toString()),
        domain: Buffer.from(DOMAIN.slice(2), "hex"),
        expiration: new BN(expiration.toString()),
        nonce: new BN(nonce.toString()),
        recipient: new PublicKey(recipient),
        token: new PublicKey(token),
        vaultAddress: new PublicKey(Buffer.from(VAULT_ADDRESS.slice(2), "hex")),
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        CHAIN_ID, // chainId (used to get config)
        depository.account.address, // depository (unused)
        base58ToBytes32(token), // currency
        amount, // amount
        base58ToBytes32(recipient), // receiver
        encodeAbiParameters(
          [{ type: "uint64" }, { type: "int64" }],
          [nonce, expiration]
        ), // data (nonce and expiration)
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeDepositoryRequest(payload)

      // Compare the decoded values with the original request
      expect(Buffer.from(decodedRequest.domain).toString("hex")).to.equal(
        DOMAIN.slice(2)
      )
      expect(decodedRequest.recipient.toString()).to.equal(recipient)
      expect(decodedRequest.token?.toBase58()).to.equal(
        transferRequest.token.toBase58()
      )
      expect(decodedRequest.amount.toString()).to.equal(
        transferRequest.amount.toString()
      )
      expect(decodedRequest.nonce.toString()).to.equal(
        transferRequest.nonce.toString()
      )
      expect(decodedRequest.expiration.toString()).to.equal(
        transferRequest.expiration.toString()
      )
      expect(decodedRequest.vaultAddress.toBase58()).to.equal(
        transferRequest.vaultAddress.toBase58()
      )
    })
  })

  describe("hexStringToBytes32()", function () {
    it("should parse correctly string into corresponding bytes32", async () => {
      const recipient = "ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm"
      const { payloadBuilder } = await loadFixture(deployPayloadBuilder)
      // make sure bytes32 helper in sol contract is consistent
      const encoded = base58ToBytes32(recipient)
      expect(await payloadBuilder.read.hexStringToBytes32([encoded])).to.equal(
        encoded
      )
    })
  })
})
