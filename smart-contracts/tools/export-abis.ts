#!/usr/bin/env ts-node
// Mirror Foundry artifacts from out/ into packages/abis/src/abis/
// preserving the source-path layout the previous Hardhat `export:abis`
// task produced. Each output file contains just the ABI array, and the
// package index.ts is regenerated to import every JSON it finds.
//
// Some exports come from hand-curated modules (e.g. ./versions/index.js
// merges historical contract ABIs so the indexer can decode legacy
// transactions). Those are listed in OVERRIDE_IMPORTS; the matching
// JSON file (if any) is still written but skipped in index.ts.

import fs from "fs-extra"
import path from "node:path"

const WORKSPACE_ROOT = path.resolve(__dirname, "..")
const FORGE_OUT = path.join(WORKSPACE_ROOT, "out")
const ABIS_PACKAGE = path.resolve(WORKSPACE_ROOT, "..", "packages", "abis")
const ABIS_SRC = path.join(ABIS_PACKAGE, "src")
const ABIS_OUT = path.join(ABIS_SRC, "abis")

// Source-path prefixes we never want to emit ABIs for.
const SKIP_PREFIXES = [
  "test/",
  "script/",
  "lib/forge-std/",
  "node_modules/forge-std/",
  "node_modules/@openzeppelin/contracts/",
  "hardhat/",
]

// Exports whose ABI is sourced from a hand-curated module rather than the
// auto-discovered per-contract JSON. The exported name maps to the path
// (relative to `src/`) of the module that re-exports it.
const OVERRIDE_IMPORTS: Record<string, string> = {
  RelayOracle: "./versions/index.js",
}

interface ForgeArtifact {
  abi: unknown[]
  metadata?: {
    settings?: {
      compilationTarget?: Record<string, string>
    }
  }
}

const sourcePathFromArtifact = (artifact: ForgeArtifact): string | null => {
  const target = artifact.metadata?.settings?.compilationTarget
  if (!target) return null
  const keys = Object.keys(target)
  return keys.length === 1 ? keys[0] : null
}

const outputDirForSource = (sourcePath: string): string => {
  // contracts/aurora-xcc/AuroraSdk.sol → aurora-xcc/AuroraSdk.sol
  // node_modules/solady/src/utils/Base64.sol → solady/src/utils/Base64.sol
  if (sourcePath.startsWith("contracts/")) {
    return sourcePath.slice("contracts/".length)
  }
  if (sourcePath.startsWith("node_modules/")) {
    return sourcePath.slice("node_modules/".length)
  }
  return sourcePath
}

async function walkJson(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkJson(full)))
    } else if (entry.name.endsWith(".json")) {
      out.push(full)
    }
  }
  return out
}

async function writeIndex() {
  const jsonFiles = await walkJson(ABIS_OUT)
  jsonFiles.sort()

  const lines: string[] = []
  lines.push("// This file is generated, please don't edit directly")
  lines.push(
    "// Refer to 'yarn run build:abis' in smart-contracts folder for more\n"
  )

  const exportedNames: string[] = []
  for (const jsonFile of jsonFiles) {
    const contractName = path.basename(jsonFile, ".json")
    if (OVERRIDE_IMPORTS[contractName]) continue
    const relativeFromSrc = path.relative(ABIS_SRC, jsonFile)
    lines.push(`import ${contractName} from "./${relativeFromSrc}"`)
    exportedNames.push(contractName)
  }

  for (const [name, modulePath] of Object.entries(OVERRIDE_IMPORTS)) {
    lines.push(`import { ${name} } from "${modulePath}"`)
    exportedNames.push(name)
  }

  lines.push("\n// exports")
  for (const name of exportedNames) {
    lines.push(`export { ${name} }`)
  }

  await fs.outputFile(path.join(ABIS_SRC, "index.ts"), lines.join("\n") + "\n")
}

async function main() {
  if (!(await fs.pathExists(FORGE_OUT))) {
    throw new Error(
      `out not found at ${FORGE_OUT}. Run \`forge build\` first.`
    )
  }

  await fs.remove(ABIS_OUT)

  const sourceDirs = await fs.readdir(FORGE_OUT)
  let written = 0

  for (const sourceDir of sourceDirs) {
    if (!sourceDir.endsWith(".sol")) continue

    const fullSourceDir = path.join(FORGE_OUT, sourceDir)
    const stat = await fs.stat(fullSourceDir)
    if (!stat.isDirectory()) continue

    const artifactFiles = (await fs.readdir(fullSourceDir)).filter((f) =>
      f.endsWith(".json")
    )

    for (const artifactFile of artifactFiles) {
      const artifactPath = path.join(fullSourceDir, artifactFile)
      const artifact = (await fs.readJSON(artifactPath)) as ForgeArtifact
      const sourcePath = sourcePathFromArtifact(artifact)
      if (!sourcePath) continue
      if (SKIP_PREFIXES.some((prefix) => sourcePath.startsWith(prefix))) {
        continue
      }

      const contractName = path.basename(artifactFile, ".json")
      const outDir = path.join(ABIS_OUT, outputDirForSource(sourcePath))
      const outPath = path.join(outDir, `${contractName}.json`)

      await fs.outputJSON(outPath, artifact.abi, { spaces: 2 })
      written++
    }
  }

  await writeIndex()

  console.log(`export-abis: wrote ${written} ABI(s) to ${ABIS_OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
