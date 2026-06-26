export type AllocatorActionEnvironment = "dev" | "stag" | "prod"
export type AllocatorActionVersion = "v1"

export interface AllocatorActionConfig {
  name: AllocatorActionEnvironment
  allocatorAddress: string
  hubEvmChainId: number
  allowedOracles: string[]
  oracleSignatureThreshold: number
  lighterGateway: string
  lighterGatewayChainId: number
  lighterAllowedApiKeys?: Array<{
    apiKeyIndex: number
    publicKey: string
  }>
}

export interface AllocatorAction {
  code: string
  config: AllocatorActionConfig
}

export type DepositAddressActionEnvironment = "dev"
export type DepositAddressActionVersion = "v1"

export interface DepositAddressActionConfig {
  name: DepositAddressActionEnvironment
  depositAddressManagerAddress: string
  hubEvmChainId: number
  allowedOracles: string[]
  oracleSignatureThreshold: number
}

export interface DepositAddressAction {
  code: string
  config: DepositAddressActionConfig
}

/**
 * A single packaged action version: the environment `config` plus a map of
 * VM type to the bundled JavaScript action `code`.
 */
export interface VersionedActions<Config> {
  config: Config
  code: Record<string, string>
}

/** All versions packaged for a single environment. */
export interface EnvironmentActions<Config> {
  versions: Record<string, VersionedActions<Config>>
}

/** Registry of environments, keyed by environment name. */
export type ActionRegistry<Config> = Record<string, EnvironmentActions<Config>>
