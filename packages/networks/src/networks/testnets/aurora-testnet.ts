import { NetworkConfig } from '@relay-protocol/types'

export const auroraTestnet: NetworkConfig = {
  chainId: 1313161555,
  family: 'evm',
  isTestnet: true,
  name: 'Aurora testnet',
  rpc: process.env.RPC_1313161555
    ? [process.env.RPC_1313161555]
    : ['https://testnet.aurora.dev'],
  slug: 'aurora-tesnet',
}
