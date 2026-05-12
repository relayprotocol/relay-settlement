#!/usr/bin/env bash
set -euo pipefail

# Make Ctrl+C abort the loop, not just the current chain.
trap 'echo; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMART_CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SMART_CONTRACTS_DIR"

# Deploys DepositAddressFactory to every staging EVM chain via the
# `deploy:depositAddressFactory` Hardhat task (CREATE2, idempotent).
#
# Run from the smart-contracts package:
#   cd smart-contracts
#   ./deployments/scripts/deploy-deposit-factories.sh
#   ./deployments/scripts/deploy-deposit-factories.sh --chains arbitrum,base
#   ./deployments/scripts/deploy-deposit-factories.sh --env prod
#
# Required env (with default --env stag):
#   - `contracts.stag.depository` populated for each target chain in
#     packages/networks/src/networks/<slug>.ts
#   - DEPLOYER_PRIVATE_KEY set (via .env or shell)
#   - RPC_<CHAINID> set when the network entry uses a `process.env.RPC_…`
#     fallback (gensyn, doma, etc.)

# ─── CLI args ─────────────────────────────────────────────────────────────────

ENV_NAME="stag"
CHAINS_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)    ENV_NAME="$2"; shift 2 ;;
    --chains) CHAINS_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '11,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Constants ────────────────────────────────────────────────────────────────

# Same default list as packages/depository/.../deploy-depositories.sh, minus
# chains where the staging depository deploy did not land (no on-chain code):
#   - ethereal: deployer blocked by Conduit deny list
#   - metis:    deployer underfunded
#   - syndicate: deployer underfunded
# Re-add a slug once its depository is confirmed deployed.
DEFAULT_CHAINS=(
  abstract
  ancient8
  anime
  apechain
  appchain
  arbitrum
  arbitrum_nova
  arena_z
  avalanche
  b3
  base
  berachain
  blast
  bnb
  bob
  boba
  celo
  corn
  cronos
  cyber
  degen
  doma
  ethereum
  flow
  gensyn
  gnosis
  gravity
  gunz
  hemi
  hyperevm
  ink
  katana
  linea
  lisk
  manta
  mantle
  megaeth
  mode
  monad
  morph
  mythos
  optimism
  perennial
  plasma
  plume
  polygon
  polygon_zkevm
  rari
  redstone
  ronin
  scroll
  sei
  shape
  somnia
  soneium
  sonic
  stable
  story
  superposition
  superseed
  swellchain
  taiko
  tempo
  unichain
  worldchain
  xai
  zero
  zircuit
  zksync
  zora
)

if [[ -n "$CHAINS_ARG" ]]; then
  IFS=',' read -ra TARGET_CHAINS <<< "$CHAINS_ARG"
else
  TARGET_CHAINS=("${DEFAULT_CHAINS[@]}")
fi

# ─── Main ─────────────────────────────────────────────────────────────────────

echo "Env:    $ENV_NAME"
echo "Chains: ${TARGET_CHAINS[*]}"
echo ""

FAILED=()

for slug in "${TARGET_CHAINS[@]}"; do
  echo ""
  printf '%0.s─' {1..60}; echo
  echo "Deploying factory: $slug"
  printf '%0.s─' {1..60}; echo

  set +e
  yarn hardhat deploy:depositAddressFactory --env "$ENV_NAME" --network "$slug"
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "✗ $slug — failed (exit $exit_code)"
    FAILED+=("$slug")
  else
    echo "✓ $slug — success"
  fi
done

echo ""
printf '%0.s═' {1..60}; echo
total="${#TARGET_CHAINS[@]}"
passed=$(( total - ${#FAILED[@]} ))
echo "Done: ${passed}/${total} succeeded"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
fi
printf '%0.s═' {1..60}; echo

[[ ${#FAILED[@]} -eq 0 ]]
