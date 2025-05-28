import { NetworkConfig } from '@relay-protocol/types'

export const auroraTestnet: NetworkConfig = {
  assets: {
    wNEAR: '0x4861825E75ab14553E5aF711EbbE6873d369d146',
  },
  chainId: 1313161555,
  family: 'evm',
  isTestnet: true,
  name: 'Aurora testnet',
  rpc: process.env.RPC_1313161555
    ? [process.env.RPC_1313161555]
    : ['https://testnet.aurora.dev'],
  slug: 'aurora-testnet',
}
