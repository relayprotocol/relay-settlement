#!/usr/bin/env ts-node
// The target version is computed from the published `latest` version,
// so running this repeatedly on the same branch produces the same version.
//
// Major and minor version changes are handled manually by developers.

import { execFileSync } from "node:child_process"
import fs from "fs-extra"
import { createRequire } from "node:module"
import path from "node:path"

const WORKSPACE_ROOT = path.resolve(__dirname, "..")
const ABIS_PACKAGE = path.resolve(WORKSPACE_ROOT, "..", "packages", "abis")
const ABIS_OUT = path.join(ABIS_PACKAGE, "src", "abis")
const PACKAGE_JSON = path.join(ABIS_PACKAGE, "package.json")
const CACHE_DIR = path.join(
  WORKSPACE_ROOT,
  "node_modules",
  ".cache",
  "settlement-abis-baseline"
)

const IGNORED_CONTRACTS = ["RelayOracle"]

type Abis = Record<string, unknown>

const warn = (message: string) => {
  console.warn(`version-abis: ${message}`)
}

const npm = (args: string[]): string =>
  execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

const publishedVersion = (name: string): string | null => {
  try {
    const version = npm(["view", name, "version", "--no-workspaces"])
    return version || null
  } catch {
    return null
  }
}

// Downloads the published NPM package to compare contract ABIs.
const publishedAbis = (name: string, version: string): Abis | null => {
  const versionDir = path.join(CACHE_DIR, version)
  const distEntry = path.join(versionDir, "package", "dist", "index.js")

  if (!fs.pathExistsSync(distEntry)) {
    try {
      fs.ensureDirSync(versionDir)
      npm([
        "pack",
        `${name}@${version}`,
        "--pack-destination",
        versionDir,
        "--no-workspaces",
      ])
      const tarball = fs
        .readdirSync(versionDir)
        .find((file) => file.endsWith(".tgz"))
      if (!tarball) throw new Error("no tarball produced")
      execFileSync("tar", ["-xzf", tarball, "-C", "."], {
        cwd: versionDir,
        stdio: "ignore",
      })
    } catch {
      fs.removeSync(versionDir)
      return null
    }
  }

  try {
    return createRequire(__filename)(distEntry) as Abis
  } catch {
    fs.removeSync(versionDir)
    return null
  }
}

const localAbis = (): Abis => {
  const abis: Abis = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(".json")) {
        abis[path.basename(entry.name, ".json")] = fs.readJSONSync(full)
      }
    }
  }
  walk(ABIS_OUT)
  return abis
}

const changedExports = (published: Abis, local: Abis): string[] => {
  const names = new Set([...Object.keys(published), ...Object.keys(local)])
  for (const name of IGNORED_CONTRACTS) names.delete(name)

  return [...names]
    .filter(
      (name) =>
        JSON.stringify(published[name] ?? null) !==
        JSON.stringify(local[name] ?? null)
    )
    .sort()
}

const parseVersion = (version: string): [number, number, number] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const isGreater = (
  a: [number, number, number],
  b: [number, number, number]
): boolean => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

const writeVersion = (version: string) => {
  const raw = fs.readFileSync(PACKAGE_JSON, "utf8")
  const updated = raw.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`)
  if (raw === updated) {
    warn("could not update the version field in package.json")
    return
  }
  fs.writeFileSync(PACKAGE_JSON, updated)
}

function main() {
  if (process.env.CI) return

  const pkg = fs.readJSONSync(PACKAGE_JSON) as {
    name: string
    version: string
  }

  const current = parseVersion(pkg.version)
  if (!current) {
    warn(`local version ${pkg.version} is not a plain semver version, skipping`)
    return
  }

  const published = publishedVersion(pkg.name)
  if (!published) {
    warn(`could not resolve the published version of ${pkg.name}, skipping`)
    return
  }

  const publishedParts = parseVersion(published)
  if (!publishedParts) {
    warn(`published version ${published} is a prerelease, skipping`)
    return
  }

  const baseline = publishedAbis(pkg.name, published)
  if (!baseline) {
    warn(`could not read the ABIs published in ${published}, skipping`)
    return
  }

  const changed = changedExports(baseline, localAbis())
  if (changed.length === 0) {
    console.log(`version-abis: ABIs match ${published}, version unchanged`)
    return
  }

  const [major, minor, patch] = publishedParts
  const target: [number, number, number] = [major, minor, patch + 1]
  const targetVersion = target.join(".")

  const reason = `${changed.length} export(s) changed: ${changed
    .slice(0, 5)
    .join(", ")}${changed.length > 5 ? ", ..." : ""}`

  if (!isGreater(target, current)) {
    console.log(
      `version-abis: ${reason}, version ${pkg.version} already covers current ABI changes`
    )
    return
  }

  writeVersion(targetVersion)
  console.log(
    `version-abis: ${pkg.version} -> ${targetVersion} (published ${published}, ${reason})`
  )
}

main()
