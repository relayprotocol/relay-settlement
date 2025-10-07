#!/usr/bin/env node
const { execFileSync, execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const hasFix = process.argv.includes("--fix")
const cwd = process.cwd()

// Find the root directory (has .git or yarn.lock)
function findRoot(startPath) {
  let currentPath = startPath
  while (currentPath !== path.dirname(currentPath)) {
    if (
      fs.existsSync(path.join(currentPath, ".git")) ||
      fs.existsSync(path.join(currentPath, "yarn.lock"))
    ) {
      return currentPath
    }
    currentPath = path.dirname(currentPath)
  }
  return startPath // fallback to start path
}

const rootDir = findRoot(cwd)
const prettierIgnorePath = path.join(rootDir, ".prettierignore")

// Find node_modules/.bin directory by looking up the tree
function findBinDir(startPath) {
  let currentPath = startPath
  while (currentPath !== path.dirname(currentPath)) {
    const binPath = path.join(currentPath, "node_modules", ".bin")
    const prettierPath = path.join(binPath, "prettier")
    const eslintPath = path.join(binPath, "eslint")
    // Only return if both prettier and eslint exist
    if (fs.existsSync(prettierPath) && fs.existsSync(eslintPath)) {
      return binPath
    }
    currentPath = path.dirname(currentPath)
  }
  throw new Error(
    "Could not find node_modules/.bin directory with prettier and eslint"
  )
}

const binDir = findBinDir(cwd)
const prettierBin = path.join(binDir, "prettier")
const eslintBin = path.join(binDir, "eslint")

// Determine if we're in the root (has workspaces)
const packageJson = JSON.parse(
  fs.readFileSync(path.join(cwd, "package.json"), "utf8")
)
const isRoot = packageJson.workspaces && packageJson.workspaces.length > 0
const isEslintConfig = packageJson.name === "@relay-protocol/eslint-config"

// Skip linting if we're in the eslint-config package itself
if (isEslintConfig) {
  process.exit(0)
}

if (isRoot) {
  // Root: run prettier and then workspaces
  const prettierArgs = hasFix
    ? ["--write", ".", "--ignore-path", prettierIgnorePath]
    : ["--check", ".", "--ignore-path", prettierIgnorePath]

  try {
    execFileSync(process.execPath, [prettierBin, ...prettierArgs], {
      stdio: "inherit",
      cwd,
    })
  } catch (e) {
    process.exit(1)
  }

  const workspacesCmd = hasFix
    ? "yarn workspaces foreach --all --topological-dev run lint --fix"
    : "yarn workspaces foreach --all --topological-dev run lint"

  try {
    execSync(workspacesCmd, { stdio: "inherit", cwd })
  } catch (e) {
    process.exit(1)
  }
} else {
  // Workspace package: run prettier and eslint
  const prettierArgs = hasFix
    ? ["--write", ".", "--ignore-path", prettierIgnorePath]
    : ["--check", ".", "--ignore-path", prettierIgnorePath]

  try {
    execFileSync(process.execPath, [prettierBin, ...prettierArgs], {
      stdio: "inherit",
      cwd,
    })
  } catch (e) {
    process.exit(1)
  }

  const eslintArgs = hasFix ? [".", "--fix"] : ["."]

  try {
    execFileSync(process.execPath, [eslintBin, ...eslintArgs], {
      stdio: "inherit",
      cwd,
    })
  } catch (e) {
    process.exit(1)
  }
}
