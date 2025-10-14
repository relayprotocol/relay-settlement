export type ChainType =
  | "bitcoin-vm"
  | "ethereum-vm"
  | "solana-vm"
  | "sui-vm"
  | "hyperliquid-vm"

export interface NetworkConfig {
  chainId: bigint
  name: string
  family: ChainType
  slug: string
  earliestBlock?: number
  isTestnet: boolean
  assets?: NetworkAssets
  rpc: [string, ...string[]]
  explorerApiUrl?: string
  near?: {
    rpc: string
    signer: string
  }
}

interface NetworkAssets {
  [asset: string]: string
}

export interface NetworkConfigs {
  [networkId: string]: NetworkConfig
}
