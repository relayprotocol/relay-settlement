import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { createHubClient } from '..'

const hubClient = createHubClient({
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 10,
})

describe('mint', () => {
  it('should prepare the mint transaction', async () => {
    const tx = await hubClient.mint({
      account: '0x1D682340264cF209257f24C3EDcb2a9fc0592535',
      amount: ethers.parseUnits('1', 18),
      chainId: 10,
      family: 'evm',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })
    expect(tx.data).toEqual(
      '0x156e29f6000000000000000000000000c388fbef54c899a46a826ee5b5b38048d8e44d2a608f90e3bbeae09ffadfa800ff18d38c3147f3b1460c503822e8bbfed759714c0000000000000000000000000000000000000000000000000de0b6b3a7640000'
    )
    expect(tx.value).toEqual(0n)
  })
})
