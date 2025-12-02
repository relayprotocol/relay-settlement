import { VmType } from "@reservoir0x/relay-protocol-sdk"

export interface ProtocolContracts {
  depository?: string
  oracle?: string
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
    prod?: ProtocolContracts
  }
}

interface NetworkAssets {
  [asset: string]: string
}

export interface NetworkConfigs {
  [networkId: string]: NetworkConfig
}
