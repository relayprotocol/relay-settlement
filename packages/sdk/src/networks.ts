import { VmType } from "./utils"

export type StackType =
  | "zksync"
  | "op-stack"
  | "polygon"
  | "arbitrum"
  | "scroll"
  | "starknet"

export interface ProtocolContracts {
  depository?: string
  oracle?: string
  hub?: string
  priceOracle?: string
  allocator?: string
  multisigSigner?: string
}
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
  blockExplorer?: {
    chainId: number
    network: string
    urls: {
      apiURL: string
      browserURL: string
    }
    apiKey?: string
  }
  nativeCurrency?: {
    decimals: number
    name: string
    symbol: string
  }
  near?: {
    rpc: string
    signer: string
  }
  hubChainId?: string
  contracts?: {
    dev?: ProtocolContracts
    stag?: ProtocolContracts
    prod?: ProtocolContracts
  }
  stack?: StackType // for ethereum-vm chains
  supportsOnchainAllocator?: boolean
}

interface NetworkAssets {
  [asset: string]: string
}

export interface NetworkConfigs {
  [networkId: string]: NetworkConfig
}
