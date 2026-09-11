#!/usr/bin/env tsx
/**
 * Generate `src/generated.ts` — the bundled Lit Action code + environment
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

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(__dirname, "..") // packages/lit-actions
const repoRoot = resolve(packageDir, "../..") // monorepo root
const outFile = resolve(packageDir, "src/generated.ts")
const packageName = (
  JSON.parse(
    readFileSync(resolve(packageDir, "package.json"), "utf-8")
  ) as { name: string }
).name
const require = createRequire(import.meta.url)

interface VmEntry {
  /** VM type key consumers pass to `getAllocatorAction` / `getDepositAddressAction`. */
  vmType: string
  /** Basename of the bundler's output file under `dist/actions/<env>/`. */
  distBasename: string
}

interface EnvEntry {
  env: string
  version: string
  vms: VmEntry[]
}

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
      {
        env: "dev",
        version: "v1",
        vms: [
          { vmType: "bitcoin-vm", distBasename: "bitcoin" },
          { vmType: "ethereum-vm", distBasename: "ethereum" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid" },
          { vmType: "lighter-vm", distBasename: "lighter" },
          { vmType: "solana-vm", distBasename: "solana" },
          { vmType: "ton-vm", distBasename: "ton" },
          { vmType: "tron-vm", distBasename: "tron" },
          { vmType: "xrp-vm", distBasename: "xrp" },
          { vmType: "hedera-vm", distBasename: "hedera" },
        ],
      },
      {
        env: "stag",
        version: "v1",
        vms: [
          { vmType: "bitcoin-vm", distBasename: "bitcoin" },
          { vmType: "ethereum-vm", distBasename: "ethereum" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid" },
          { vmType: "lighter-vm", distBasename: "lighter" },
          { vmType: "solana-vm", distBasename: "solana" },
          { vmType: "ton-vm", distBasename: "ton" },
          { vmType: "tron-vm", distBasename: "tron" },
          { vmType: "xrp-vm", distBasename: "xrp" },
          { vmType: "hedera-vm", distBasename: "hedera" },
        ],
      },
      {
        env: "prod",
        version: "v1",
        vms: [
          { vmType: "bitcoin-vm", distBasename: "bitcoin" },
          { vmType: "ethereum-vm", distBasename: "ethereum" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid" },
          { vmType: "lighter-vm", distBasename: "lighter" },
          { vmType: "solana-vm", distBasename: "solana" },
          { vmType: "ton-vm", distBasename: "ton" },
          { vmType: "tron-vm", distBasename: "tron" },
          { vmType: "xrp-vm", distBasename: "xrp" },
          { vmType: "hedera-vm", distBasename: "hedera" },
        ],
      },
      {
        env: "test",
        version: "v1",
        vms: [{ vmType: "ethereum-vm", distBasename: "ethereum" }],
      },
    ],
  },
  {
    registry: "depositAddressEnvs",
    configType: "DepositAddressActionConfig",
    sourcePackage: "@relay-protocol/lit-deposit-address",
    sourceDir: litDepositAddressDir,
    environments: [
      {
        env: "dev",
        version: "v1",
        vms: [
          { vmType: "ethereum-vm", distBasename: "ethereum-vm" },
          { vmType: "solana-vm", distBasename: "solana-vm" },
          { vmType: "bitcoin-vm", distBasename: "bitcoin-vm" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid-vm" },
          { vmType: "ton-vm", distBasename: "ton-vm" },
          { vmType: "tron-vm", distBasename: "tron-vm" },
        ],
      },
      {
        env: "stag",
        version: "v1",
        vms: [
          { vmType: "ethereum-vm", distBasename: "ethereum-vm" },
          { vmType: "solana-vm", distBasename: "solana-vm" },
          { vmType: "bitcoin-vm", distBasename: "bitcoin-vm" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid-vm" },
          { vmType: "ton-vm", distBasename: "ton-vm" },
          { vmType: "tron-vm", distBasename: "tron-vm" },
        ],
      },
      {
        env: "prod",
        version: "v1",
        vms: [
          { vmType: "ethereum-vm", distBasename: "ethereum-vm" },
          { vmType: "solana-vm", distBasename: "solana-vm" },
          { vmType: "bitcoin-vm", distBasename: "bitcoin-vm" },
          { vmType: "hyperliquid-vm", distBasename: "hyperliquid-vm" },
          { vmType: "ton-vm", distBasename: "ton-vm" },
          { vmType: "tron-vm", distBasename: "tron-vm" },
        ],
      },
    ],
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

interface VersionedActions {
  config: unknown
  code: Record<string, string>
}

type Registry = Record<string, { versions: Record<string, VersionedActions> }>

/**
 * Download the latest published tarball of `packageName` from npm, extract its
 * compiled `dist/generated.js`, and return each registry keyed by export name
 * so a fresh generation can be diffed against what is already published.
 *
 * Returns an empty map (and logs a note) when the package is unpublished or the
 * registry is unreachable, so generation still succeeds offline.
 */
function fetchPublishedRegistries(
  name: string,
  registryNames: string[]
): Record<string, Registry | undefined> {
  const result: Record<string, Registry | undefined> = {}
  let tmp: string
  try {
    tmp = mkdtempSync(join(tmpdir(), "lit-actions-published-"))
  } catch {
    return result
  }
  try {
    const packOutput = execFileSync(
      "npm",
      ["pack", `${name}@latest`, "--json", "--pack-destination", tmp],
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
    const published = require(
      join(tmp, "package", "dist", "generated.js")
    ) as Record<string, Registry>
    for (const registryName of registryNames) {
      if (published[registryName]) {
        result[registryName] = published[registryName]
      }
    }
    console.log(`Comparing against published ${name}@${version}`)
  } catch (err) {
    console.log(
      `Skipping published-version diff (${name}@latest unavailable): ${
        (err as Error).message
      }`
    )
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
        console.warn(`⚠️  ${registryName}: config changed for ${env}/${version}`)
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

  for (const { env, version, vms } of kind.environments) {
    if (!bundledEnvs.has(env)) {
      runBundler(kind.sourcePackage, env)
      bundledEnvs.add(env)
    }

    const config = JSON.parse(
      readFileSync(
        resolve(kind.sourceDir, "environments", `${env}.json`),
        "utf-8"
      )
    )

    const code: Record<string, string> = {}
    for (const { vmType, distBasename } of vms) {
      code[vmType] = readFileSync(
        resolve(kind.sourceDir, "dist/actions", env, `${distBasename}.js`),
        "utf-8"
      )
    }

    registry[env] ??= { versions: {} }
    registry[env].versions[version] = { config, code }
  }

  return registry
}

const publishedRegistries = fetchPublishedRegistries(
  packageName,
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
  "// AUTO-GENERATED by scripts/generate-actions.ts — DO NOT EDIT.",
  "// Regenerate with: yarn workspace @relay-protocol/lit-actions generate",
  "",
  `import type { ActionRegistry, ${configTypes.join(", ")} } from "./types"`,
  "",
].join("\n")

writeFileSync(outFile, `${header}\n${sections.join("\n\n")}\n`)
console.log(`Wrote ${outFile}`)
