import type { NetworkConfig } from "@relay-protocol/settlement-sdk"
import { readFileSync, existsSync } from "fs"

export interface OverrideConfig {
  [chainSlug: string]: Partial<NetworkConfig> & {
    esploraCompatibleApiUrl?: string
  }
}

export interface LoadChainsOptions {
  overrideFile?: string
}

function loadOverrideFile(overrideFile?: string): OverrideConfig | null {
  if (!overrideFile) {
    return null
  }

  if (!existsSync(overrideFile)) {
    return null
  }

  try {
    const content = readFileSync(overrideFile, "utf-8")
    return JSON.parse(content) as OverrideConfig
  } catch (error) {
    console.warn(`Failed to load override file ${overrideFile}:`, error)
    return null
  }
}

// recurisvely merge objects, with overrides taking precedence
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base }

  for (const key in override) {
    if (override[key] === undefined) {
      continue
    }

    const baseValue = result[key]
    const overrideValue = override[key]

    // If both are objects  (not arrays), merge recursively
    if (
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue) &&
      overrideValue &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>
      )
    } else {
      // override takes precedence
      result[key] = overrideValue
    }
  }

  return result
}

// Merge base config with overrides
export function mergeOverrides(
  baseConfig: NetworkConfig,
  overrides: OverrideConfig[string] | undefined
): NetworkConfig {
  if (!overrides) {
    return baseConfig
  }

  // use deep merge for nested objects
  const merged = deepMerge(
    baseConfig as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>
  ) as unknown as NetworkConfig

  // handle RPC arrays
  if (
    overrides.rpc &&
    Array.isArray(overrides.rpc) &&
    overrides.rpc.length > 0
  ) {
    merged.rpc = overrides.rpc as [string, ...string[]]
  }

  return merged
}

export function loadChainsWithOverrides(
  baseNetworks: Record<string, NetworkConfig>,
  options: LoadChainsOptions = {}
): Record<string, NetworkConfig> {
  const { overrideFile } = options
  const overrides = loadOverrideFile(overrideFile)
  if (!overrides) {
    return baseNetworks
  }

  const result: Record<string, NetworkConfig> = { ...baseNetworks }

  // apply overrides to matching networks by slug
  for (const [chainSlug, overrideConfig] of Object.entries(overrides)) {
    // find network by slug
    const network = baseNetworks[chainSlug]
    if (network) {
      result[chainSlug] = mergeOverrides(network, overrideConfig)
    }
  }

  return result
}
