import { BN } from '@coral-xyz/anchor'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { PublicKey } from '@solana/web3.js'
import { expect } from 'chai'
import hre from 'hardhat'

import { encodeAbiParameters } from 'viem'
import {
  base58ToBytes32,
  decodeEscrowRequest,
  hashRequest,
} from '../../../lib/solana'

describe('Allocator SolanaPayloadBuilder', function () {
  async function deployAllocator() {
    const [escrow, receiver] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const payloadBuilder = await hre.viem.deployContract('SolanaPayloadBuilder')

    return {
      escrow,
      payloadBuilder,
      publicClient,
      receiver,
    }
  }

  describe('buildPayload()', function () {
    it('should build a payload when using SOL (native currency)', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)
      const transferRequest = {
        amount: new BN(100000000),
        expiration: new BN(1749096009),
        nonce: new BN(1749095710252),
        recipient: new PublicKey(
          '38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH'
        ),
        token: null,
      }

      const { bytes } = hashRequest(transferRequest)

      // Test data from the new example
      const amount = 100000000n
      const receiverBase58 = '38WpM5VeBuUM1GLTF8aWAYs4p4JDVPjrFxh1YRxzFpLH'
      // Convert base58 to bytes32
      const receiverHex = base58ToBytes32(receiverBase58)

      // Encode nonce and expiration in data parameter
      const nonce = 1749095710252n // From test data
      const expiration = 1749096009n // From test data
      const data = encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'int64' }],
        [nonce, expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        '', // currency (empty string for SOL)
        amount,
        receiverHex,
        data,
      ])

      expect(payload).to.equal(bytes)
    })

    it('should build a payload when using an SPL token', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)
      const transferRequest = {
        amount: new BN(100000000),
        expiration: new BN(1749096049),
        nonce: new BN(1749095749158),
        recipient: new PublicKey(
          'FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD'
        ),
        token: new PublicKey('5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE'),
      }

      const { bytes } = hashRequest(transferRequest)
      const amount = 100000000n
      const receiverBase58 = 'FDx39MbXSupLUaxmN3SQ9x3G6mtTjemZVcWgz7jkcvTD'
      const tokenBase58 = '5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE'

      const receiverHex = base58ToBytes32(receiverBase58)
      const tokenHex = base58ToBytes32(tokenBase58)

      // Use same nonce and expiration as native test for consistency
      const nonce = 1749095749158n
      const expiration = 1749096049n
      const data = encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'int64' }],
        [nonce, expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n,
        escrow.account.address,
        tokenHex,
        amount,
        receiverHex,
        data,
      ])

      expect(payload).to.be.a('string')
      expect(payload.startsWith('0x')).to.equal(true)
      expect(payload.length).to.be.greaterThan(2)
      expect(payload).to.equal(bytes)
    })
  })

  describe('hashesToSign()', function () {
    it('should hash a payload correctly using SHA-256', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Use the new test data payload
      const payload =
        '0x1fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a0000e1f505000000002c7e3a3e970100004916416800000000'

      const hash = await payloadBuilder.read.hashesToSign([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        payload,
      ])

      // Expected hash from new test data
      const expectedHash =
        '0x853751cf9b1d747bbcf62a293a707cc322e95c606908bb857bdddb318f7ab292'
      expect(hash[0]).to.equal(expectedHash)
    })
  })

  describe('toBytes32()', function () {
    it('should parse correctly string into corresponding bytes32', async () => {
      const recipient = 'ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm'
      const { payloadBuilder } = await loadFixture(deployAllocator)
      // make sure bytes32 helper in sol contract is consistent
      const encoded = base58ToBytes32(recipient)
      expect(await payloadBuilder.read.toBytes32([encoded])).to.equal(encoded)
    })
  })

  describe('decodeEscrowRequest', function () {
    const amount = 1n
    const expiration = 1749096009n
    const nonce = 1749095710252n
    const recipient = 'ETZgVwqLnzZFQfK2YB1rDLratt4cCGwNHcV8jJokrxmm'

    async function deployAllocator() {
      const [escrow, receiver] = await hre.viem.getWalletClients()
      const publicClient = await hre.viem.getPublicClient()
      const payloadBuilder = await hre.viem.deployContract(
        'SolanaPayloadBuilder'
      )

      return {
        escrow,
        payloadBuilder,
        publicClient,
        receiver,
      }
    }

    it('should correctly decode a native SOL transfer request', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Create a test transfer request
      const transferRequest = {
        amount: new BN(amount.toString()),
        expiration: new BN(expiration.toString()),
        nonce: new BN(nonce.toString()),
        recipient: new PublicKey(recipient),
        token: null,
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        '', // currency (empty string for SOL)
        amount, // amount
        base58ToBytes32(recipient), // receiver
        encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'int64' }],
          [nonce, expiration]
        ), // data (nonce and expiration)
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeEscrowRequest(payload)

      // Compare the decoded values with the original request
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
    })

    it('should correctly decode an SPL token transfer request', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      const token = '5nUXHYLUrYv9PmeN4RKZ1iwUFBGWmoqMTajEiKNsXRdE'
      // Create a test transfer request with an SPL token
      const transferRequest = {
        amount: new BN(amount.toString()),
        expiration: new BN(expiration.toString()),
        nonce: new BN(nonce.toString()),
        recipient: new PublicKey(recipient),
        token: new PublicKey(token),
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        base58ToBytes32(token), // currency
        amount, // amount
        base58ToBytes32(recipient), // receiver
        encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'int64' }],
          [nonce, expiration]
        ), // data (nonce and expiration)
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeEscrowRequest(payload)

      // Compare the decoded values with the original request
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
    })
  })
})
