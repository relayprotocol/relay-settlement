import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { createHubClient } from '..'

const hubClient = createHubClient({
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 10n,
})

describe('burn', () => {
  it('should prepare the burn transaction', async () => {
    const tx = await hubClient.burn({
      account: '0x1D682340264cF209257f24C3EDcb2a9fc0592535',
      amount: ethers.parseUnits('1', 18),
      chainId: 10n,
      family: 'ethereum-vm',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })
    expect(tx.data).toEqual(
      '0xf5298aca000000000000000000000000c388fbef54c899a46a826ee5b5b38048d8e44d2a7c87c17d6f360b864fb885ac69aeca732f99c5726cbba7287e9d244785fac37d0000000000000000000000000000000000000000000000000de0b6b3a7640000'
    )
    expect(tx.value).toEqual(0n)
  })
})
