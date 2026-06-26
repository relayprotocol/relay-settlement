import type {
  NetworkConfig,
  NetworkConfigs,
} from "@relay-protocol/settlement-sdk"
import * as supportedNetworks from "./networks"
import {
  loadChainsWithOverrides,
  type LoadChainsOptions,
} from "./config-loader"

// Initialize networks object with overrides applied
export function initializeNetworks(
  overrides: LoadChainsOptions = {}
): NetworkConfigs {
  const baseNetworks: NetworkConfigs = {}
  Object.keys(supportedNetworks).forEach((networkName: string) => {
    // @ts-expect-error Element implicitly has an 'any' type
    const network = supportedNetworks[networkName]
    if (network && network.slug) {
      baseNetworks[network.slug] = network
    }
  })

  const networksWithOverrides = loadChainsWithOverrides(baseNetworks, overrides)
  const networks: NetworkConfigs = {}
  Object.values(networksWithOverrides).forEach((network: NetworkConfig) => {
    networks[network.slug] = network
    networks[network.chainId.toString()] = network
  })

  return networks
}
