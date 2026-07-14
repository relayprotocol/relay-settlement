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
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(__dirname, "..") // packages/lit-actions
const repoRoot = resolve(packageDir, "../..") // monorepo root
const outFile = resolve(packageDir, "src/generated.ts")

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
        ],
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

const sections: string[] = []
for (const kind of KINDS) {
  const registry = buildRegistry(kind)
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
