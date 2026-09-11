#!/usr/bin/env bash
set -euo pipefail

# Ctrl+C aborts the whole loop, not just the current chain.
trap 'echo; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPOSITORY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$DEPOSITORY_DIR"

# Verify staging RelayDepository deployments on each chain.
#
# Reads the deployed address per chain from Foundry broadcast files
# produced by deploy-depositories.sh, then runs forge verify-contract
# against the chain's block explorer.
#
# Run from the depository ethereum-vm package:
#   cd packages/depository/packages/ethereum-vm
#   ./deployments/scripts/verify-depositories.sh
#   ./deployments/scripts/verify-depositories.sh --chains arbitrum,base
#
# Required env (always):
#   ALLOCATOR              MPC signer address (same as deploy)
#   DEPOSITORY_OWNER       MPC signer address (same as deploy)
#
# Required env (per chain):
#   RPC_<SLUG_UPPERCASE>   RPC URL — used to read chainId
#   ETHERSCAN_API_KEY_<SLUG_UPPERCASE>  (optional) explorer API key
#                          falls back to ETHERSCAN_API_KEY if unset

# ─── Load .env ────────────────────────────────────────────────────────────────

if [[ -f .env ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    [[ -n "$key" && -z "${!key+x}" ]] && export "$key"="$val"
  done < .env
fi

# ─── CLI args ─────────────────────────────────────────────────────────────────

CHAINS_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chains) CHAINS_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${ALLOCATOR:-}" || -z "${DEPOSITORY_OWNER:-}" ]]; then
  echo "Error: ALLOCATOR and DEPOSITORY_OWNER env vars are required" >&2
  exit 1
fi

# ─── Constants ────────────────────────────────────────────────────────────────

# Same default list as deploy-depositories.sh.
DEFAULT_CHAINS=(
  abstract ancient8 anime apechain appchain arbitrum arbitrum_nova arena_z
  avalanche b3 base berachain blast bnb bob boba celo corn cronos cyber degen
  doma ethereal ethereum flow gensyn gnosis gravity gunz hemi hyperevm ink
  katana linea lisk manta mantle megaeth metis mode monad morph mythos
  optimism perennial plasma plume polygon polygon_zkevm rari redstone ronin
  scroll sei shape somnia soneium sonic stable story superposition superseed
  syndicate taiko tempo unichain worldchain xai zero zircuit
  zksync zora
)

if [[ -n "$CHAINS_ARG" ]]; then
  IFS=',' read -ra TARGET_CHAINS <<< "$CHAINS_ARG"
else
  TARGET_CHAINS=("${DEFAULT_CHAINS[@]}")
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

# tr-based uppercase for Bash 3.2 (macOS default) compatibility
upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

rpc_url() {
  local slug="$1"
  local env_key="RPC_$(upper "$slug")"
  if [[ -z "${!env_key:-}" ]]; then
    echo "Error: ${env_key} not set" >&2
    return 1
  fi
  echo "${!env_key}"
}

api_key() {
  local slug="$1"
  local env_key="ETHERSCAN_API_KEY_$(upper "$slug")"
  if [[ -n "${!env_key:-}" ]]; then
    echo "${!env_key}"
  elif [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
    echo "${ETHERSCAN_API_KEY}"
  else
    echo ""
  fi
}

# Read deployed depository address from the latest forge broadcast file.
# Returns empty string if not found.
deployed_address() {
  local chain_id="$1"
  local broadcast_file="broadcast/RelayDepositoryDeployer.s.sol/${chain_id}/run-latest.json"
  if [[ ! -f "$broadcast_file" ]]; then
    return 1
  fi
  # First contractAddress in transactions array (the deploy tx)
  jq -r '.transactions[] | select(.contractName == "RelayDepository") | .contractAddress' \
    "$broadcast_file" | head -n1
}

# ─── Main ─────────────────────────────────────────────────────────────────────

CONSTRUCTOR_ARGS="$(cast abi-encode 'constructor(address,address)' "$DEPOSITORY_OWNER" "$ALLOCATOR")"

FAILED=()

for slug in "${TARGET_CHAINS[@]}"; do
  if ! rpc="$(rpc_url "$slug")"; then
    FAILED+=("$slug (no RPC)")
    continue
  fi

  chain_id="$(cast chain-id --rpc-url "$rpc" 2>/dev/null || echo "")"
  if [[ -z "$chain_id" ]]; then
    echo "✗ $slug — could not fetch chainId from $rpc"
    FAILED+=("$slug (chainId)")
    continue
  fi

  if ! addr="$(deployed_address "$chain_id")" || [[ -z "$addr" ]]; then
    echo "⏭️  $slug ($chain_id) — no broadcast record, skipping"
    continue
  fi

  key="$(api_key "$slug")"

  echo ""
  printf '%0.s─' {1..60}; echo
  echo "Verifying: $slug ($chain_id) at $addr"
  printf '%0.s─' {1..60}; echo

  forge_args=(
    verify-contract
    "$addr"
    src/RelayDepository.sol:RelayDepository
    --chain "$chain_id"
    --constructor-args "$CONSTRUCTOR_ARGS"
    --watch
  )
  [[ -n "$key" ]] && forge_args+=(--etherscan-api-key "$key")

  set +e
  forge "${forge_args[@]}"
  exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    FAILED+=("$slug")
    echo "✗ $slug — verification failed"
  else
    echo "✓ $slug — verified"
  fi
done

echo ""
printf '%0.s═' {1..60}; echo
total="${#TARGET_CHAINS[@]}"
passed=$(( total - ${#FAILED[@]} ))
echo "Done: ${passed}/${total} verified"
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
fi
printf '%0.s═' {1..60}; echo

[[ ${#FAILED[@]} -eq 0 ]]
