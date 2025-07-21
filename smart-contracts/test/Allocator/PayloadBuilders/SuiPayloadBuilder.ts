import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { encodeAbiParameters } from 'viem'
import {
  decodeEscrowRequest,
  normalizeType,
  hashRequest,
} from '../../../lib/sui'
import { Hex } from 'viem'

describe('Allocator SuiPayloadBuilder', function () {
  async function deployAllocator() {
    const [escrow, receiver] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const payloadBuilder = await hre.viem.deployContract('SuiPayloadBuilder')

    return {
      escrow,
      payloadBuilder,
      publicClient,
      receiver,
    }
  }

  describe('buildPayload()', function () {
    it('should build a payload when using SUI (native currency)', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Create a transfer request for SUI
      const transferRequest = {
        amount: 500n,
        coin_type: {
          name: normalizeType('0x2::sui::SUI'),
        },
        expiration: 1750663024480n,
        nonce: 1750662424480n,
        recipient:
          '0x5097529b04079ab34fbe734e658f199a66645f9c6c12fe24348830ca9617fcf4',
      }

      const { bytes } = hashRequest(transferRequest)

      // Encode nonce and expiration in data parameter
      const data = encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'uint64' }],
        [transferRequest.nonce, transferRequest.expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        transferRequest.coin_type.name,
        transferRequest.amount,
        transferRequest.recipient,
        data,
      ])

      expect(payload).to.equal(bytes)
    })

    it('should build a payload when using a custom coin', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Define a custom coin type (similar to USDC in the Sui tests)
      const customCoin =
        '0xf3c2bf47b0439563547e53615c277c8c4342b3f0074a23218e37c7e4c1f7121a::usdc::USDC'

      // Create a transfer request with custom coin
      const transferRequest = {
        amount: 100000000n,
        coin_type: {
          name: normalizeType(customCoin),
        },
        expiration: 1749096049n,
        nonce: 1749095749158n,
        recipient:
          '0x622f2b76c7331bbe04365995bcb287e0648cd4631455a25e62f54c76e5e28143',
      }

      const { bytes } = hashRequest(transferRequest)

      // Encode nonce and expiration in data parameter
      const data = encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'uint64' }],
        [transferRequest.nonce, transferRequest.expiration]
      )

      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        transferRequest.coin_type.name,
        transferRequest.amount,
        transferRequest.recipient,
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

      // Create a sample Sui transfer request
      const transferRequest = {
        amount: 500n,
        coin_type: {
          name: normalizeType('0x2::sui::SUI'),
        },
        expiration: 1750663024480n,
        nonce: 1750662424480n,
        recipient:
          '0x5097529b04079ab34fbe734e658f199a66645f9c6c12fe24348830ca9617fcf4',
      }

      const { bytes, hash: expectedHash } = hashRequest(transferRequest)

      const hash = await payloadBuilder.read.hashesToSign([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        bytes as Hex,
      ])

      expect(hash[0]).to.equal(expectedHash)
    })
  })

  describe('curve()', function () {
    it('should return Eddsa as the curve type', async () => {
      const { payloadBuilder } = await loadFixture(deployAllocator)
      expect(await payloadBuilder.read.curve()).to.equal('Eddsa')
    })
  })

  describe('decodeEscrowRequest', function () {
    const amount = 1n
    const expiration = 1749096009n
    const nonce = 1749095710252n
    const recipient =
      '0x622f2b76c7331bbe04365995bcb287e0648cd4631455a25e62f54c76e5e28143'

    it('should correctly decode a native SUI transfer request', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Create a sample Sui transfer request
      const transferRequest = {
        amount: 500n,
        coin_type: {
          name: normalizeType('0x2::sui::SUI'),
        },
        expiration: 1750663024480n,
        nonce: 1750662424480n,
        recipient:
          '0x5097529b04079ab34fbe734e658f199a66645f9c6c12fe24348830ca9617fcf4',
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        transferRequest.coin_type.name,
        transferRequest.amount,
        transferRequest.recipient,
        encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'uint64' }],
          [transferRequest.nonce, transferRequest.expiration]
        ),
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeEscrowRequest(payload)

      // Compare the decoded values with the original request
      expect(decodedRequest.recipient).to.equal(transferRequest.recipient)
      expect(decodedRequest.coin_type.name).to.equal(
        normalizeType('0x2::sui::SUI')
      ) // Default SUI
      expect(decodedRequest.amount).to.equal(transferRequest.amount.toString())
      expect(decodedRequest.nonce).to.equal(transferRequest.nonce.toString())
      expect(decodedRequest.expiration).to.equal(
        transferRequest.expiration.toString()
      )
    })

    it('should correctly decode a custom coin transfer request', async () => {
      const { payloadBuilder, escrow } = await loadFixture(deployAllocator)

      // Define a custom coin type (similar to USDC in the Sui tests)
      const customCoin =
        '0xf3c2bf47b0439563547e53615c277c8c4342b3f0074a23218e37c7e4c1f7121a::usdc::USDC'

      // Create a transfer request with custom coin
      const transferRequest = {
        amount: 100000000n,
        coin_type: {
          name: normalizeType(customCoin),
        },
        expiration: 1749096049n,
        nonce: 1749095749158n,
        recipient:
          '0x622f2b76c7331bbe04365995bcb287e0648cd4631455a25e62f54c76e5e28143',
      }

      // Encode the request using the contract
      const payload = await payloadBuilder.read.buildPayload([
        1n, // chainId (unused)
        escrow.account.address, // escrow (unused)
        transferRequest.coin_type.name,
        transferRequest.amount,
        transferRequest.recipient,
        encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'uint64' }],
          [transferRequest.nonce, transferRequest.expiration]
        ),
      ])

      // Decode the payload using our utility function
      const decodedRequest = decodeEscrowRequest(payload)

      // Compare the decoded values with the original request
      expect(decodedRequest.recipient).to.equal(transferRequest.recipient)
      expect(decodedRequest.coin_type.name).to.equal(normalizeType(customCoin))
      expect(decodedRequest.amount).to.equal(transferRequest.amount.toString())
      expect(decodedRequest.nonce).to.equal(transferRequest.nonce.toString())
      expect(decodedRequest.expiration).to.equal(
        transferRequest.expiration.toString()
      )
    })
  })
})
