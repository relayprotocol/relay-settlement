import { describe, expect, test } from 'vitest'
import { generateAddress } from './address'
import { addressesTestCases } from '@relay-protocol/fixtures'
import { TokenIdComponents } from '@relay-protocol/types'
import { ethers } from 'ethers'

describe('Virtual Addresses', () => {
  test.each(addressesTestCases)('$name', ({ input, expectedAddress }) => {
    const address = generateAddress(input)

    const differentInput = { ...input, chainId: input.chainId + 1 }
    const differentAddress = generateAddress(differentInput)
    expect(address).not.toBe(differentAddress)
    expect(address).toBe(expectedAddress)

    // address with correct checksum
    expect(ethers.getAddress(expectedAddress)).toBe(expectedAddress)
  })

  test('should handle case-insensitive EVM addresses', () => {
    const addr = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    const input1: TokenIdComponents = {
      address: addr,
      chainId: 1,
      family: 'evm',
    }
    const input2: TokenIdComponents = {
      address: addr.toLowerCase(),
      chainId: 1,
      family: 'evm',
    }

    expect(generateAddress(input1)).toBe(generateAddress(input2))
  })
})
