import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import { deployAllocator } from '../helpers/deployAllocator'
import { hexToBytes, keccak256 } from 'viem'

describe('Allocator encodeJSONRequest', function () {
  it('should correctly encode a JSON request with a payload hash', async function () {
    const { allocator } = await loadFixture(deployAllocator)

    // Create a test payload hash
    const payloadHash = keccak256('0x1234')
    const path = '0x1234567890123456789012345678901234567890'
    const version = 1n

    const result = await allocator.read.encodeJSONRequest([
      payloadHash,
      'Ecdsa',
      path,
      version,
    ])

    // Convert result to string for easier comparison
    const resultStr = Buffer.from(hexToBytes(result)).toString('utf8')

    const jsonResult = JSON.parse(resultStr)
    expect(jsonResult.request).to.be.an('object')
    expect(jsonResult.request.payload_v2).to.be.an('object')
    expect(jsonResult.request.payload_v2.Ecdsa).to.be.an('string')
    expect(jsonResult.request.path).to.equal(path)
    expect(jsonResult.request.domain_id).to.equal(Number(version))
  })

  it('should handle different paths', async function () {
    const { allocator } = await loadFixture(deployAllocator)

    const payloadHash = keccak256('0x1234')
    const path = '0xaBcDef1234567890123456789012345678901234'
    const version = 1n

    const result = await allocator.read.encodeJSONRequest([
      payloadHash,
      'Ecdsa',
      path,
      version,
    ])

    const resultStr = Buffer.from(hexToBytes(result)).toString('utf8')
    const jsonResult = JSON.parse(resultStr)
    expect(jsonResult.request.path).to.equal(path)
  })
})
