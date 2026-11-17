#!/usr/bin/env tsx
/**
 * Generate `src/generated.ts`: the bundled Lit Action code + environment
 * config that this package re-exports.
 *
 * The action sources live in the `@relay-protocol/lit-allocator` and
 * `@relay-protocol/lit-deposit-address` packages, each with its own tested
 * esbuild bundler (`scripts/bundle-actions.ts`). Rather than committing copies
 * of those bundles, this script runs each source package's bundler and reads
 * the emitted `dist/actions/<env>/<vm>.js` files plus `environments/<env>.json`
 * config, then writes a single generated module. `src/generated.ts` is
 * git-ignored and produced on every build (see the package `build` script).
 *
 * Usage:
 *   tsx scripts/generate-actions.ts
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  isFrozenEntry,
  mixedVersionConfig,
  resolveFrozenVersion,
  type EnvEntry,
  type Registry,
  type VersionedActions,
  type VmEntry,
} from "./registry"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(__dirname, "..") // packages/lit-actions
const repoRoot = resolve(packageDir, "../..") // monorepo root
const outFile = resolve(packageDir, "src/generated.ts")
const packageName = (
  JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf-8")) as {
    name: string
  }
).name
const require = createRequire(import.meta.url)

interface KindSpec {
  /** Exported registry name in the generated module. */
  registry: string
  /** Config type (from `./types`) the registry is parameterized by. */
  configType: string
  /** Source workspace name whose `bundle:actions` script produces the bundles. */
  sourcePackage: string
  /** Source workspace directory. */
  sourceDir: string
  environments: EnvEntry[]
}

const litAllocatorDir = resolve(repoRoot, "packages/lit-allocator")
const litDepositAddressDir = resolve(repoRoot, "packages/lit-deposit-address")

const ALLOCATOR_VMS: VmEntry[] = [
  { vmType: "bitcoin-vm", distBasename: "bitcoin" },
  { vmType: "ethereum-vm", distBasename: "ethereum" },
  { vmType: "gateway-vm", distBasename: "gateway" },
  { vmType: "hyperliquid-vm", distBasename: "hyperliquid" },
  { vmType: "lighter-vm", distBasename: "lighter" },
  { vmType: "solana-vm", distBasename: "solana" },
  { vmType: "ton-vm", distBasename: "ton" },
  { vmType: "tron-vm", distBasename: "tron" },
  { vmType: "xrp-vm", distBasename: "xrp" },
  { vmType: "hedera-vm", distBasename: "hedera" },
  { vmType: "atlas-vm", distBasename: "atlas", configKeys: ["atlasDomain"] },
]

/**
 * Last published package whose allocator `v1` and `v2` bundles are the live
 * CIDs in every environment but test `v2`. `v2` signs for the allocator each environment ran
 * before the Hub-chain core redeploy (DEC-1891); dev's redeployed allocator is
 * signed by `v3`.
 */
const ALLOCATOR_V1_V2_PACKAGE = "0.0.41"

/** Last published package whose dev allocator `v3` bundles are the live dev v3 CIDs. */
const ALLOCATOR_DEV_V3_PACKAGE = "0.0.42"

/**
 * Last published package whose test allocator `v2` bundles are the live test v2
 * CIDs (the Oct 29 Atlas format on the pre-redeploy allocator 0xf62db37a).
 * Frozen so it keeps that address while the redeployed allocator gets `v3`.
 */
const ALLOCATOR_TEST_V2_PACKAGE = "0.0.43"

/**
 * Last published package whose non-Atlas test allocator `v3` bundles are the
 * test v3 CIDs (the redeployed test allocator 0x1E2092B7). Frozen so later
 * source changes do not move them.
 */
const ALLOCATOR_TEST_V3_PACKAGE = "0.0.47"

/**
 * Last published package whose stag allocator `v3` bundles are the stag v3 CIDs
 * (the redeployed stag allocator 0xfe200c7F). Frozen so later source changes
 * do not move them.
 */
const ALLOCATOR_STAG_V3_PACKAGE = "0.0.48"

/** Last published package whose deposit-address `v1` bundles are the live v1 CIDs. */
const DEPOSIT_ADDRESS_V1_PACKAGE = "0.0.36"

/** Last published package whose deposit-address `v1.1` bundles are the live v1.1 CIDs. */
const DEPOSIT_ADDRESS_V1_1_PACKAGE = "0.0.39"

/** Last published package whose non-XRP deposit-address `v1.2` bundles are the live CIDs. */
const DEPOSIT_ADDRESS_V1_2_PACKAGE = "0.0.44"

/** VMs a built deposit-address version picks its bundles from. */
const DEPOSIT_ADDRESS_VMS: VmEntry[] = [
  { vmType: "ethereum-vm", distBasename: "ethereum-vm" },
  { vmType: "solana-vm", distBasename: "solana-vm" },
  { vmType: "bitcoin-vm", distBasename: "bitcoin-vm" },
  { vmType: "hyperliquid-vm", distBasename: "hyperliquid-vm" },
  { vmType: "ton-vm", distBasename: "ton-vm" },
  { vmType: "tron-vm", distBasename: "tron-vm" },
  { vmType: "xrp-vm", distBasename: "xrp-vm" },
]

/**
 * The published surface. Each VM type maps to the bundler output it is built
 * from. Add or remove entries here to change what `getAllocatorAction` /
 * `getDepositAddressAction` expose.
 */
const KINDS: KindSpec[] = [
  {
    registry: "allocatorEnvs",
    configType: "AllocatorActionConfig",
    sourcePackage: "@relay-protocol/lit-allocator",
    sourceDir: litAllocatorDir,
    environments: [
      // Frozen without `vms`: each version is copied whole, including the
      // gateway-vm bundle v1 gained after 0.0.32.
      ...["dev", "stag", "prod", "test"].flatMap((env): EnvEntry[] =>
        ["v1", "v2"]
          .filter((version) => env !== "test" || version === "v1")
          .map((version) => ({
            env,
            version,
            from: { publishedPackage: ALLOCATOR_V1_V2_PACKAGE },
          }))
      ),
      {
        env: "dev",
        version: "v3",
        from: { publishedPackage: ALLOCATOR_DEV_V3_PACKAGE },
      },
      // Test's pre-redeploy allocator (0xf62db37a) stays for atlas-testnet: v2
      // (Oct 29 Atlas format) is now frozen from its published package so it
      // keeps that address instead of rebuilding against environments/test.json.
      {
        env: "test",
        version: "v2",
        from: { publishedPackage: ALLOCATOR_TEST_V2_PACKAGE },
      },
      // The redeployed test allocator (0x1E2092B7), which v3 signs for
      // (DEC-1891). Only Atlas picks up current source, for the Nov 9 gapless
      // format; every other VM keeps its published 0.0.47 bytes.
      {
        env: "test",
        version: "v3",
        from: {
          publishedPackage: ALLOCATOR_TEST_V3_PACKAGE,
          vmTypes: ALLOCATOR_VMS.filter(
            ({ vmType }) => vmType !== "atlas-vm"
          ).map(({ vmType }) => vmType),
        },
        vms: ALLOCATOR_VMS.filter(({ vmType }) => vmType === "atlas-vm"),
      },
      // The redeployed stag allocator (0xfe200c7F), which v3 signs for
      // (DEC-2540), frozen from its published package. Stag v1 and v2 stay
      // frozen above for the pre-redeploy allocator 0xbdcd959c.
      {
        env: "stag",
        version: "v3",
        from: { publishedPackage: ALLOCATOR_STAG_V3_PACKAGE },
      },
      // environments/prod.json names the redeployed prod allocator (0xa68dcB6c),
      // which v3 signs for (DEC-2469). Prod v1 and v2 stay frozen above for the
      // pre-redeploy allocator 0x613d3c58.
      { env: "prod", version: "v3", vms: ALLOCATOR_VMS },
    ],
  },
  {
    registry: "depositAddressEnvs",
    configType: "DepositAddressActionConfig",
    sourcePackage: "@relay-protocol/lit-deposit-address",
    sourceDir: litDepositAddressDir,
    environments: ["dev", "stag", "prod"].flatMap((env): EnvEntry[] => [
      // Frozen versions copy the published registry verbatim. Without `vms`,
      // they never pick up VMs added to DEPOSIT_ADDRESS_VMS.
      {
        env,
        version: "v1",
        from: { publishedPackage: DEPOSIT_ADDRESS_V1_PACKAGE },
      },
      {
        env,
        version: "v1.1",
        from: { publishedPackage: DEPOSIT_ADDRESS_V1_1_PACKAGE },
      },
      // Only XRP picks up current source. Every other VM keeps its published
      // 0.0.44 bytes.
      {
        env,
        version: "v1.2",
        from: {
          publishedPackage: DEPOSIT_ADDRESS_V1_2_PACKAGE,
          vmTypes: DEPOSIT_ADDRESS_VMS.filter(
            ({ vmType }) => vmType !== "xrp-vm"
          ).map(({ vmType }) => vmType),
        },
        vms: DEPOSIT_ADDRESS_VMS.filter(({ vmType }) => vmType === "xrp-vm"),
      },
    ]),
  },
]

/** Run a source package's bundler for one environment. */
function runBundler(sourcePackage: string, env: string): void {
  console.log(`Bundling ${sourcePackage} (${env})…`)
  execFileSync(
    "yarn",
    ["workspace", sourcePackage, "bundle:actions", "--env", env],
    {
      cwd: repoRoot,
      stdio: "inherit",
    }
  )
}

/** Published registries already downloaded in this run, keyed by version spec. */
const publishedRegistryCache = new Map<
  string,
  Record<string, Registry | undefined>
>()

/**
 * Download a published tarball of `packageName` from npm, extract its compiled
 * `dist/generated.js`, and return each registry keyed by export name. `spec` is
 * either `"latest"` (used to diff a fresh generation against what is already
 * published) or an exact version a frozen entry is copied from.
 *
 * A `latest` lookup returns an empty map (and logs a note) when the package is
 * unpublished or the registry is unreachable, so generation still succeeds
 * offline. An exact version rethrows: a frozen entry must never be silently
 * skipped or rebuilt from source.
 *
 * Results are memoised per `spec`, so a version referenced by several frozen
 * entries is downloaded once.
 */
function fetchPublishedRegistries(
  name: string,
  spec: string,
  registryNames: string[]
): Record<string, Registry | undefined> {
  const cached = publishedRegistryCache.get(spec)
  if (cached) {
    return pickRegistries(cached, registryNames)
  }

  const published: Record<string, Registry | undefined> = {}
  let tmp: string
  try {
    tmp = mkdtempSync(join(tmpdir(), "lit-actions-published-"))
  } catch (err) {
    if (spec !== "latest") {
      throw new Error(
        `failed to fetch ${name}@${spec}: ${(err as Error).message}`
      )
    }
    return published
  }
  try {
    const packOutput = execFileSync(
      "npm",
      ["pack", `${name}@${spec}`, "--json", "--pack-destination", tmp],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    )
    const [{ filename, version }] = JSON.parse(packOutput) as {
      filename: string
      version: string
    }[]
    execFileSync("tar", ["-xzf", join(tmp, filename), "-C", tmp], {
      stdio: "ignore",
    })
    // `dist/generated.js` only has type-only imports (erased at build time), so
    // it can be required standalone without pulling in runtime dependencies.
    const generated = require(
      join(tmp, "package", "dist", "generated.js")
    ) as Record<string, Registry>
    for (const [registryName, registry] of Object.entries(generated)) {
      published[registryName] = registry
    }
    publishedRegistryCache.set(spec, published)
    console.log(`Comparing against published ${name}@${version}`)
  } catch (err) {
    if (spec !== "latest") {
      throw new Error(
        `failed to fetch ${name}@${spec}: ${(err as Error).message}`
      )
    }
    console.log(
      `Skipping published-version diff (${name}@latest unavailable): ${
        (err as Error).message
      }`
    )
  }
  return pickRegistries(published, registryNames)
}

/** Narrow a published registry map to the registries a caller asked for. */
function pickRegistries(
  published: Record<string, Registry | undefined>,
  registryNames: string[]
): Record<string, Registry | undefined> {
  const result: Record<string, Registry | undefined> = {}
  for (const registryName of registryNames) {
    if (published[registryName]) {
      result[registryName] = published[registryName]
    }
  }
  return result
}

/**
 * Warn when a freshly generated registry differs from the latest published
 * version, per env / version / vm type. Helps catch unexpected changes to
 * bundled action code (e.g. from a dependency bump) before they ship. No-op
 * when there is no published version to compare against.
 */
function warnOnRegistryChanges(
  registryName: string,
  previous: Registry | undefined,
  current: Registry
): void {
  if (!previous) return
  for (const [env, { versions }] of Object.entries(current)) {
    const previousEnv = previous[env]
    if (!previousEnv) {
      console.warn(`⚠️  ${registryName}: new environment "${env}"`)
      continue
    }
    for (const [version, actions] of Object.entries(versions)) {
      const previousActions = previousEnv.versions[version]
      if (!previousActions) {
        console.warn(
          `⚠️  ${registryName}: new version "${version}" for env "${env}"`
        )
        continue
      }
      if (
        JSON.stringify(actions.config) !==
        JSON.stringify(previousActions.config)
      ) {
        console.warn(
          `⚠️  ${registryName}: config changed for ${env}/${version}`
        )
      }
      for (const [vmType, code] of Object.entries(actions.code)) {
        const previousCode = previousActions.code[vmType]
        if (previousCode === undefined) {
          console.warn(
            `⚠️  ${registryName}: new action ${env}/${version}/${vmType}`
          )
        } else if (previousCode !== code) {
          console.warn(
            `⚠️  ${registryName}: code changed for ${env}/${version}/${vmType}`
          )
        }
      }
    }
  }
}

/** Build the `{ versions: { <version>: { config, code } } }` map for one kind. */
function buildRegistry(
  kind: KindSpec
): Record<string, { versions: Record<string, VersionedActions> }> {
  const bundledEnvs = new Set<string>()
  const registry: Record<
    string,
    { versions: Record<string, VersionedActions> }
  > = {}

  for (const entry of kind.environments) {
    const { env, version } = entry
    registry[env] ??= { versions: {} }

    let frozen: VersionedActions | undefined
    if (isFrozenEntry(entry)) {
      const published = fetchPublishedRegistries(
        packageName,
        entry.from.publishedPackage,
        [kind.registry]
      )
      frozen = resolveFrozenVersion(
        kind.registry,
        published[kind.registry],
        entry
      )
      console.log(
        `Froze ${kind.registry} ${env}/${version} from ${packageName}@${entry.from.publishedPackage}`
      )
      registry[env].versions[version] = frozen
      if (!entry.vms?.length) {
        continue
      }
    }

    if (!bundledEnvs.has(env)) {
      runBundler(kind.sourcePackage, env)
      bundledEnvs.add(env)
    }

    const environment = JSON.parse(
      readFileSync(
        resolve(kind.sourceDir, "environments", `${env}.json`),
        "utf-8"
      )
    )
    const config = frozen
      ? mixedVersionConfig(frozen.config, environment, entry.vms ?? [])
      : environment

    const code: Record<string, string> = { ...frozen?.code }
    for (const { vmType, distBasename } of entry.vms ?? []) {
      if (vmType in code) {
        throw new Error(
          `Cannot replace frozen action ${kind.registry}/${env}/${version}/${vmType}`
        )
      }
      code[vmType] = readFileSync(
        resolve(kind.sourceDir, "dist/actions", env, `${distBasename}.js`),
        "utf-8"
      )
    }

    registry[env].versions[version] = { config, code }
  }

  return registry
}

const publishedRegistries = fetchPublishedRegistries(
  packageName,
  "latest",
  KINDS.map((k) => k.registry)
)

const sections: string[] = []
for (const kind of KINDS) {
  const registry = buildRegistry(kind)
  warnOnRegistryChanges(
    kind.registry,
    publishedRegistries[kind.registry],
    registry
  )
  sections.push(
    `export const ${kind.registry}: ActionRegistry<${kind.configType}> = ${JSON.stringify(
      registry,
      null,
      2
    )}`
  )
}

const configTypes = [...new Set(KINDS.map((k) => k.configType))].sort()
const header = [
  "// AUTO-GENERATED by scripts/generate-actions.ts: DO NOT EDIT.",
  "// Regenerate with: yarn workspace @relay-protocol/lit-actions generate",
  "",
  `import type { ActionRegistry, ${configTypes.join(", ")} } from "./types"`,
  "",
].join("\n")

writeFileSync(outFile, `${header}\n${sections.join("\n\n")}\n`)
console.log(`Wrote ${outFile}`)
