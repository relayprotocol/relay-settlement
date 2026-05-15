#!/usr/bin/env ts-node
// Yarn workspaces hoist Solidity dependencies (e.g. @openzeppelin, solady)
// to the repo-root node_modules/. Foundry resolves remappings relative to
// the foundry.toml location (smart-contracts/), so it can't see hoisted
// packages. Hardhat already walks up the tree via node module resolution
// so it doesn't care.
//
// Rather than duplicating installs or maintaining "../node_modules/" paths
// in remappings.txt (which Hardhat rejects), we create symlinks from
// smart-contracts/node_modules/<pkg> to the hoisted location. This keeps
// remappings.txt environment-independent and both toolchains happy.

import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const SCRIPT_DIR = dirname(__filename)
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..")
const REPO_ROOT = resolve(WORKSPACE_ROOT, "..")

const PACKAGES = ["@openzeppelin", "solady"]

function ensureSymlink(target: string, linkPath: string): void {
  const linkDir = dirname(linkPath)
  if (!existsSync(linkDir)) {
    mkdirSync(linkDir, { recursive: true })
  }

  const relativeTarget = relative(linkDir, target)

  if (existsSync(linkPath)) {
    try {
      const existing = readlinkSync(linkPath)
      if (existing === relativeTarget) return
      unlinkSync(linkPath)
    } catch {
      console.warn(
        `link-solidity-deps: ${linkPath} exists and is not a symlink; leaving in place.`
      )
      return
    }
  }

  symlinkSync(relativeTarget, linkPath, "dir")
  console.log(`link-solidity-deps: ${linkPath} -> ${relativeTarget}`)
}

function main(): void {
  // Allow opting out from environments that mount only smart-contracts/ and
  // can't resolve symlinks pointing up to the repo root (e.g. the slither
  // Docker action). Those environments handle dependency resolution
  // themselves and shouldn't pay the cost of a broken symlink left behind.
  if (process.env.SKIP_SOLIDITY_DEPS_SYMLINKS === "1") {
    console.log(
      "link-solidity-deps: SKIP_SOLIDITY_DEPS_SYMLINKS=1, skipping."
    )
    return
  }

  for (const pkg of PACKAGES) {
    const hoisted = join(REPO_ROOT, "node_modules", pkg)
    if (!existsSync(hoisted)) {
      console.warn(
        `link-solidity-deps: ${pkg} not found at ${hoisted}; skipping. Run \`yarn install\` from the repo root first.`
      )
      continue
    }

    const link = join(WORKSPACE_ROOT, "node_modules", pkg)
    ensureSymlink(hoisted, link)
  }
}

main()
