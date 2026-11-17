export type AllocatorActionEnvironment = "dev" | "stag" | "prod" | "test"
export type AllocatorActionVersion = "v1" | "v2" | "v3"

interface AllocatorActionConfigBase {
  name: AllocatorActionEnvironment
  allocatorAddress: string
  hubEvmChainId: number
  allowedOracles: string[]
  oracleSignatureThreshold: number
}

/** `v1` configuration: a single Lighter gateway. */
export interface AllocatorActionConfigV1 extends AllocatorActionConfigBase {
  lighterGateway?: string
  lighterGatewayChainId?: number
  lighterAllowedApiKeys?: Array<{
    apiKeyIndex: number
    publicKey: string
  }>
}

/** One Lighter deployment, keyed by the EIP-155 chain id of its L1. */
export interface LighterGatewayConfig {
  chainId: number
  gateway: string
  allowedApiKeys: Array<{
    apiKeyIndex: number
    publicKey: string
  }>
}

/** Deployment-specific fields of the Atlas EIP-712 signing domain. */
export interface AtlasDomainConfig {
  chainId: number
  /** Set on versions built before the Oct 29 Atlas release, which signed without a salt. */
  verifyingContract?: string
  salt?: string
}

/** `v2` and `v3` configuration: one or more Lighter gateways and an optional Atlas domain. */
export interface AllocatorActionConfigV2 extends AllocatorActionConfigBase {
  lighterGateways?: LighterGatewayConfig[]
  atlasDomain?: AtlasDomainConfig
}

/**
 * Configuration shared by every packaged allocator version. Every Lighter
 * field is optional so existing consumers keep compiling; use the `V1`/`V2`
 * types (or the version-specific `getAllocatorAction` overloads) for precision.
 */
export interface AllocatorActionConfig
  extends AllocatorActionConfigV1,
    AllocatorActionConfigV2 {}

export interface AllocatorAction<Config = AllocatorActionConfig> {
  code: string
  config: Config
}

export type DepositAddressActionEnvironment = "dev" | "stag" | "prod"
export type DepositAddressActionVersion = "v1" | "v1.1" | "v1.2"

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
