export type ChainType = 'evm' | 'bitcoin' | 'solana'

export interface NetworkConfig {
  chainId: number | bigint
  name: string
  family: ChainType
  slug: string
  earliestBlock?: number
  isTestnet: boolean
  assets?: NetworkAssets
  rpc: [string, ...string[]]
}

interface NetworkAssets {
  [asset: string]: string
}

export interface NetworkConfigs {
  [networkId: string]: NetworkConfig
}
