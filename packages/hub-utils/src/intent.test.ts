import { describe, expect, test } from 'vitest'
import { intentTestCases } from '@relay-protocol/fixtures'
import { getIntentAddress } from './intent'
import { ethers } from 'ethers'

describe('Intent Ids', () => {
  test.each(intentTestCases)('$name', ({ id, expectedAddress }) => {
    const address = getIntentAddress(id)
    expect(address).toBe(expectedAddress)
    // address with correct checksum
    expect(ethers.getAddress(expectedAddress)).toBe(expectedAddress)
  })
})
