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
      family: 'ethereum-vm',
      operatorAddress: '0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c',
    })
    expect(tx.data).toEqual(
      '0xc29ffa41000000000000000000000000cca30d2818c2d7de99e25c33dc96893c8310f0310000000000000000000000004307d40d23347bf84ae5867dfc183933a3b29ed30000000000000000000000000000000000000000000000000000000000000001'
    )
    expect(tx.value).toEqual(0n)
  })
})
