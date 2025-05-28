import { NetworkConfig } from '@relay-protocol/types'

export const aurora: NetworkConfig = {
  assets: {
    wNEAR: '0xC42C30aC6Cc15faC9bD938618BcaA1a1FaE8501d',
  },
  chainId: 1313161554,
  family: 'evm',
  isTestnet: false,
  name: 'Aurora Mainnet (Near)',
  rpc: process.env.RPC_1313161554
    ? [process.env.RPC_1313161554]
    : ['https://mainnet.aurora.dev'],
  slug: 'aurora',
}
