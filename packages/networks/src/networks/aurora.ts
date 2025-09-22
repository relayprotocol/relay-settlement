import { NetworkConfig } from '@relay-protocol/types'

export const aurora: NetworkConfig = {
  assets: {
    wNEAR: '0xC42C30aC6Cc15faC9bD938618BcaA1a1FaE8501d',
  },
  chainId: 1313161554n,
  etherscan: {
    apiKey: 'T',
    config: {
      chainId: 1313161554n,
      network: 'aurora',
      urls: {
        apiURL: 'https://explorer.mainnet.aurora.dev/api',
        browserURL: 'http://explorer.mainnet.aurora.dev',
      },
    },
  },
  family: 'ethereum-vm',
  isTestnet: false,
  name: 'Aurora Mainnet (Near)',
  near: {
    rpc: 'https://rpc.mainnet.near.org',
    signer: 'v1.signer',
  },
  rpc: process.env.RPC_1313161554
    ? [process.env.RPC_1313161554]
    : ['https://mainnet.aurora.dev'],
  slug: 'aurora',
}
