import { VmType } from "@reservoir0x/relay-protocol-sdk"

export interface NetworkConfig {
  chainId: bigint
  name: string
  family: VmType
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
