import { ethers } from 'ethers'
import { describe, expect, it } from 'vitest'
import { createHubClient } from '..'

const hubClient = createHubClient({
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 10n,
})

describe('transferFrom', () => {
  it('should prepare the transferFrom transaction', async () => {
    const tx = await hubClient.transferFrom({
      account: '0x1D682340264cF209257f24C3EDcb2a9fc0592535',
      amount: ethers.parseUnits('1', 18),
      chainId: 10n,
      family: 'ethereum-vm',
      recipientAddress: '0xd62B65923E77Be56ae35C46D90A85D74a83A4A9c',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })
    expect(tx.data).toEqual(
      '0xfe99049a000000000000000000000000cca30d2818c2d7de99e25c33dc96893c8310f0310000000000000000000000004307d40d23347bf84ae5867dfc183933a3b29ed37c87c17d6f360b864fb885ac69aeca732f99c5726cbba7287e9d244785fac37d0000000000000000000000000000000000000000000000000de0b6b3a7640000'
    )
    expect(tx.value).toEqual(0n)
  })
})
