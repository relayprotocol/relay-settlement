import type { NetworkConfig as SdkNetworkConfig } from "@relay-protocol/settlement-sdk"

export interface NetworkConfig extends SdkNetworkConfig {
  /** True when the RPC list comes from this package's non-empty defaults. */
  usesDefaultRpc?: boolean
}

export interface NetworkConfigs {
  [networkId: string]: NetworkConfig
}
