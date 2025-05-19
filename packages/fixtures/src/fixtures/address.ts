import { TokenIdComponents } from '@relay-protocol/types'
export const addressesTestCases: Array<{
  name: string
  input: TokenIdComponents
  expectedAddress: `0x${string}`
}> = [
  {
    input: {
      address: '0x0000000000000000000000000000000000000000',
      chainId: 1,
      family: 'evm',
    },
    expectedAddress: '0x900C5beBABD7DDF3C35CCE2d206F386C63a67763',
    name: 'ETH on Ethereum', // '0x' + 64 hex characters
  },
  {
    expectedAddress: '0x17BaE7e0E3B54d775F77DfFBc8Ce4fDb9D967FA4',
    input: {
      address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      chainId: 1,
      family: 'bitcoin',
    },
    name: 'Bitcoin',
  },
  {
    expectedAddress: '0x81655EF7d57D0dD5665D89e48C331DFd34CfBB60',
    input: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      chainId: 1,
      family: 'solana',
    },
    name: 'USDC on Solana',
  },
  {
    expectedAddress: '0xBbf511716716CcD27BaD0Db819802E6cDb1961ff',
    input: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      family: 'evm',
    },
    name: 'USDC on Base',
  },
]
