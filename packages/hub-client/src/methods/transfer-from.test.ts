import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { createHubClient } from '..'

const hubClient = createHubClient({
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 10,
})

describe('transferFrom', () => {
  it('should prepare the transferFrom transaction', async () => {
    const tx = await hubClient.transferFrom({
      account: '0x1D682340264cF209257f24C3EDcb2a9fc0592535',
      amount: ethers.parseUnits('1', 18),
      chainId: 10,
      family: 'evm',
      recipientAddress: '0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })
    expect(tx.data).toEqual(
      '0xfe99049a000000000000000000000000c388fbef54c899a46a826ee5b5b38048d8e44d2a000000000000000000000000ffd93fa9e30a595d492711ba2d42076b0bded09e608f90e3bbeae09ffadfa800ff18d38c3147f3b1460c503822e8bbfed759714c0000000000000000000000000000000000000000000000000de0b6b3a7640000'
    )
    expect(tx.value).toEqual(0n)
  })
})
