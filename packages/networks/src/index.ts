import { initializeNetworks } from "./networks-index"

export * from "./networks"
export * from "./config-loader"
export * from "./networks-index"
export type { NetworkConfig, NetworkConfigs } from "./types"

export const networks = initializeNetworks()

export default networks
