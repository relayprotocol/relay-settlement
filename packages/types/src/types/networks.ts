export type ChainType = 'bitcoin-vm' | 'ethereum-vm' | 'solana-vm' | 'sui-vm'

interface EtherscanNetworkConfig {
  apiKey: string
  config: {
    chainId: bigint
    network: string
    urls: {
      apiURL: string
      browserURL: string
    }
  }
}

export interface NetworkConfig {
  chainId: bigint
  name: string
  etherscan?: EtherscanNetworkConfig
  family: ChainType
  slug: string
  earliestBlock?: number
  isTestnet: boolean
  assets?: NetworkAssets
  rpc: [string, ...string[]]
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
