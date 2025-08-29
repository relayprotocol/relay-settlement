import { describe, expect, it } from 'vitest'
import { createHubClient } from '..'

const hubClient = createHubClient({
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 10n,
})

describe('setOperatorFor', () => {
  it('should prepare the setOperatorFor transaction', async () => {
    const tx = await hubClient.setOperatorFor({
      account: '0x1D682340264cF209257f24C3EDcb2a9fc0592535',
      approved: true,
      chainId: 10n,
      operatorAddress: '0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c',
    })
    expect(tx.data).toEqual(
      '0xc29ffa41000000000000000000000000c388fbef54c899a46a826ee5b5b38048d8e44d2a000000000000000000000000ffd93fa9e30a595d492711ba2d42076b0bded09e0000000000000000000000000000000000000000000000000000000000000001'
    )
    expect(tx.value).toEqual(0n)
  })
})
