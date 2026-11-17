/**
 * Pure helpers for the release matrix in `generate-actions.ts`.
 *
 * A matrix entry is either *built* (its bundles come from the source package's
 * bundler) or *frozen* (its config and code are copied verbatim from a pinned,
 * already-published version of this package). Freezing is how an older action
 * version keeps its exact CIDs while a newer version is built from source.
 */

export interface VmEntry {
  /** VM type key consumers pass to `getAllocatorAction` / `getDepositAddressAction`. */
  vmType: string
  /** Basename of the bundler's output file under `dist/actions/<env>/`. */
  distBasename: string
  /** Environment config fields only this VM's bundle embeds. */
  configKeys?: string[]
}

export interface BuiltEnvEntry {
  env: string
  version: string
  vms: VmEntry[]
}

export interface FrozenEnvEntry {
  env: string
  version: string
  /** Exact published version of this package to copy the env/version from. */
  from: {
    publishedPackage: string
    /** Copy only these VMs when mixing frozen and newly built bundles. */
    vmTypes?: string[]
  }
  vms?: VmEntry[]
}

export type EnvEntry = BuiltEnvEntry | FrozenEnvEntry

export interface VersionedActions {
  config: unknown
  code: Record<string, string>
}

export type Registry = Record<
  string,
  { versions: Record<string, VersionedActions> }
>

export function isFrozenEntry(entry: EnvEntry): entry is FrozenEnvEntry {
  return "from" in entry
}

/**
 * Return the published `{ config, code }` for a frozen entry, or throw. A
 * frozen version is never rebuilt or silently dropped: if the pinned package
 * cannot supply it, generation must fail.
 */
export function resolveFrozenVersion(
  registryName: string,
  published: Registry | undefined,
  entry: FrozenEnvEntry
): VersionedActions {
  const pin = `@${entry.from.publishedPackage}`
  if (!published) {
    throw new Error(
      `${registryName}: cannot freeze ${entry.env}/${entry.version}: ${pin} has no ${registryName} registry`
    )
  }
  const actions = published[entry.env]?.versions[entry.version]
  if (!actions) {
    throw new Error(
      `${registryName}: cannot freeze ${entry.env}/${entry.version}: not present in ${pin}`
    )
  }
  if (!entry.from.vmTypes) return actions

  const code: Record<string, string> = {}
  for (const vmType of entry.from.vmTypes) {
    if (!actions.code[vmType]) {
      throw new Error(
        `${registryName}: cannot freeze ${entry.env}/${entry.version}/${vmType}: not present in ${pin}`
      )
    }
    code[vmType] = actions.code[vmType]
  }
  return { config: actions.config, code }
}

/**
 * Config of a version that mixes frozen and built bundles: the frozen config,
 * with the fields only its built VMs embed taken from the environment they
 * were built with, so the config describes every bundle next to it.
 */
export function mixedVersionConfig(
  frozenConfig: unknown,
  environment: Record<string, unknown>,
  builtVms: VmEntry[]
): unknown {
  const config = { ...(frozenConfig as Record<string, unknown>) }
  for (const key of builtVms.flatMap((vm) => vm.configKeys ?? [])) {
    if (key in environment) {
      config[key] = environment[key]
    } else {
      delete config[key]
    }
  }
  return config
}
