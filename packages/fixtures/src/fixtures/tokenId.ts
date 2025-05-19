import { TokenIdComponents } from '@relay-protocol/types'
export const tokenIdTestCases: Array<{
  name: string
  input: TokenIdComponents
  expectedLength: number
  expectedValue: bigint
}> = [
  {
    expectedLength: 66,
    expectedValue:
      78051395535287417827063584897405809888583020418092851394496101884361051633507n,
    input: {
      address: '0x0000000000000000000000000000000000000000',
      chainId: 1,
      family: 'evm',
    },
    name: 'ETH on Ethereum', // '0x' + 64 hex characters
  },
  {
    expectedLength: 66,
    expectedValue:
      54669162877514710005738411391664089827359327443976864294332674275893289844644n,
    input: {
      address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      chainId: 1,
      family: 'bitcoin',
    },
    name: 'Bitcoin',
  },
  {
    expectedLength: 66,
    expectedValue:
      98561313466494535556816499499729286402645494443814293410896430861984101022560n,
    input: {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      chainId: 1,
      family: 'solana',
    },
    name: 'USDC on Solana',
  },
  {
    expectedLength: 66,
    expectedValue:
      91011626713223330294058701363236552008263148926138155798246432140767289500159n,
    input: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chainId: 8453,
      family: 'evm',
    },
    name: 'USDC on Base',
  },
]
