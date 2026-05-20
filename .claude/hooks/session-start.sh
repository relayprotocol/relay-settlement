#!/usr/bin/env bash
# SessionStart hook: provisions the toolchain Claude Code on the web sessions
# need so the agent doesn't burn turns rediscovering setup.
#
# What it does (idempotent, safe to re-run):
#   1. Installs Foundry (forge/cast/anvil) by downloading the prebuilt
#      release tarball from GitHub. Avoids foundry.paradigm.xyz, which is
#      blocked by the default Claude Code on the web network policy.
#   2. Initializes git submodules (forge-std under smart-contracts and
#      packages/depository/packages/ethereum-vm).
#   3. Runs `yarn install`, which also triggers smart-contracts' postinstall
#      script to symlink hoisted Solidity deps into smart-contracts/node_modules.
#
# Only runs in Claude Code on the web (CLAUDE_CODE_REMOTE=true) so local
# developer machines are unaffected.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

log() { printf '[session-start] %s\n' "$*" >&2; }

FOUNDRY_BIN="$HOME/.foundry/bin"

# 1. Foundry — fetch prebuilt binary from GitHub releases (stable channel).
if [ ! -x "$FOUNDRY_BIN/forge" ]; then
  log "Installing Foundry from GitHub release tarball..."
  uname_m="$(uname -m)"
  case "$uname_m" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) log "Unsupported architecture: $uname_m"; exit 1 ;;
  esac
  uname_s="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$uname_s" in
    linux|darwin) os="$uname_s" ;;
    *) log "Unsupported OS: $uname_s"; exit 1 ;;
  esac
  tarball="foundry_stable_${os}_${arch}.tar.gz"
  url="https://github.com/foundry-rs/foundry/releases/download/stable/${tarball}"
  mkdir -p "$FOUNDRY_BIN"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  curl -fsSL -o "$tmpdir/$tarball" "$url"
  tar -xzf "$tmpdir/$tarball" -C "$FOUNDRY_BIN"
  chmod +x "$FOUNDRY_BIN"/*
else
  log "Foundry already installed; skipping."
fi

# Persist PATH for the session so subsequent Bash tool calls see forge.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$FOUNDRY_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
export PATH="$FOUNDRY_BIN:$PATH"

# 1b. solc 0.8.28 for svm-rs (used by forge). Foundry's default svm-rs source
# (binaries.soliditylang.org) is blocked by the network policy; fetch from
# the official GitHub release instead and seed ~/.svm so `forge build` /
# `forge test` skip the download.
SOLC_VERSION="0.8.28"
SVM_DIR="$HOME/.svm/$SOLC_VERSION"
SVM_BIN="$SVM_DIR/solc-$SOLC_VERSION"
if [ ! -x "$SVM_BIN" ]; then
  log "Fetching solc $SOLC_VERSION from GitHub..."
  mkdir -p "$SVM_DIR"
  curl -fsSL -o "$SVM_BIN" \
    "https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/solc-static-linux"
  chmod +x "$SVM_BIN"
else
  log "solc $SOLC_VERSION already cached; skipping."
fi

# 2. Submodules (forge-std lives here for both smart-contracts and depository)
log "Initializing git submodules..."
git submodule update --init --recursive

# 3. Yarn deps + smart-contracts postinstall (link-solidity-deps).
# Invoke the vendored Yarn 4.x release directly to avoid corepack's network
# fetch from repo.yarnpkg.com, which is blocked by the default network policy.
log "Running yarn install..."
yarn_release="$(awk '/^yarnPath:/ { print $2 }' .yarnrc.yml | tr -d '"')"
if [ -z "$yarn_release" ] || [ ! -f "$yarn_release" ]; then
  log "Could not locate vendored yarn release from .yarnrc.yml (yarnPath=$yarn_release)"
  exit 1
fi
node "$yarn_release" install --immutable

log "Done."
