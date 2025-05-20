import { VirtualAddressComponents } from '@relay-protocol/types'
export const addressesTestCases: Array<{
  name: string
  input: VirtualAddressComponents
  expectedAddress: `0x${string}`
}> = [
  {
    expectedAddress: '0x5CC7C5F24C34AFAf30Fcb95af8c2528506c2ed4e',
    input: {
      address: '0x0000000000000000000000000000000000000000',
      chainId: 1,
    },
    name: 'ETH on Ethereum', // '0x' + 64 hex characters
  },
  {
    expectedAddress: '0x469148eBe03892603f72981C95AeFb9d71B73dB3',
    input: {
      address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      chainId: 1,
    },
    name: 'Bitcoin',
  },
  {
    expectedAddress: '0x4e8a6eB3820C5815b2496181073b8992776d60f6',
    input: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      chainId: 1,
    },
    name: 'USDC on Solana',
  },
  {
    expectedAddress: '0x7c6EA41A770C8c6c7F5D70e55146B606e8075c3B',
    input: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
    },
    name: 'USDC on Base',
  },
]
