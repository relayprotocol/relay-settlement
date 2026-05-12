#!/usr/bin/env bash
set -euo pipefail

# Make Ctrl+C abort the whole loop. Without this, SIGINT only kills the
# current forge child; the parent loop captures the non-zero exit and
# moves to the next chain.
trap 'echo; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPOSITORY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$DEPOSITORY_DIR"

# Deploys RelayDepository to all staging EVM chains via the deterministic
# CREATE2 factory at 0x4e59b44847b379578588920cA78FBf26c0B4956c.
#
# Run from the depository ethereum-vm package:
#   cd packages/depository/packages/ethereum-vm
#   ./deployments/scripts/deploy-depositories.sh                # dry run
#   ./deployments/scripts/deploy-depositories.sh --execute      # broadcast
#   ./deployments/scripts/deploy-depositories.sh --execute --salt 3
#   ./deployments/scripts/deploy-depositories.sh --execute --chains arbitrum,base
#
# Required env (always):
#   ALLOCATOR              MPC signer address derived from the staging
#                          RelayAllocator (NOT the allocator contract address).
#                          Get with `yarn hardhat allocator:signer-address \
#                            --network aurora --env stag --family ethereum-vm`.
#   DEPOSITORY_OWNER       MPC signer address derived from the staging
#                          RelayMultisigSigner (the cross-chain owner).
#                          Get with `yarn hardhat allocator:signer-address \
#                            --network aurora --allocator <multisigSigner> \
#                            --family ethereum-vm`.
#
# Required env (with --execute):
#   DEPLOYER_PRIVATE_KEY   Private key of the deployer wallet
#
# Required env (per chain):
#   RPC_<SLUG_UPPERCASE>   RPC URL for the chain (e.g. RPC_ARBITRUM,
#                          RPC_DOMA). Underscores in the slug stay as
#                          underscores (RPC_ARBITRUM_NOVA, RPC_ARENA_Z).
#                          Set in .env or the shell environment.

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

EXECUTE=false
SALT=""
ALLOCATOR_ARG=""
OWNER_ARG=""
CHAINS_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)   EXECUTE=true; shift ;;
    --salt)      SALT="$2"; shift 2 ;;
    --allocator) ALLOCATOR_ARG="$2"; shift 2 ;;
    --owner)     OWNER_ARG="$2"; shift 2 ;;
    --chains)    CHAINS_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ALLOCATOR="${ALLOCATOR_ARG:-${ALLOCATOR:-}}"
DEPOSITORY_OWNER="${OWNER_ARG:-${DEPOSITORY_OWNER:-}}"
PK="${DEPLOYER_PRIVATE_KEY:-}"

if [[ -z "$ALLOCATOR" ]]; then
  echo "Error: ALLOCATOR env var or --allocator <addr> is required" >&2
  exit 1
fi
if [[ -z "$DEPOSITORY_OWNER" ]]; then
  echo "Error: DEPOSITORY_OWNER env var or --owner <addr> is required" >&2
  exit 1
fi
if $EXECUTE && [[ -z "$PK" ]]; then
  echo "Error: DEPLOYER_PRIVATE_KEY is required with --execute" >&2
  exit 1
fi

# ─── Constants ────────────────────────────────────────────────────────────────

CREATE2_FACTORY="0x4e59b44847b379578588920cA78FBf26c0B4956c"
TIMEOUT_SECS=240

# Default chains — every staging EVM target. Override with --chains.
# Excludes hyperliquid (hyperliquid-vm family, custom deploy flow) and
# lighter (no depository — destination-only chain).
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
  ethereal
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
  metis
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
  syndicate
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

# ─── Helpers ──────────────────────────────────────────────────────────────────

rpc_url() {
  local slug="$1"
  # tr-based uppercase for Bash 3.2 (macOS default) compatibility
  local env_key="RPC_$(printf '%s' "$slug" | tr '[:lower:]' '[:upper:]')"
  if [[ -z "${!env_key:-}" ]]; then
    echo "Error: ${env_key} not set. Add it to .env or export it." >&2
    return 1
  fi
  echo "${!env_key}"
}

# London-EVM chains — use the london foundry profile for compatibility.
is_london() {
  # gunz, hyperevm: no PUSH0 (EIP-3855) support → must compile with
  # london evm_version. forge prints "EIP-3855 is not supported" warning
  # for the affected chains.
  case "$1" in cronos|gunz|hyperevm|mantle|metis|polygon_zkevm) return 0 ;; esac
  return 1
}

# Chains that don't support EIP-1559 fee estimation (no eth_feeHistory),
# OR have non-standard gas accounting that breaks forge's 1559 path
# (hyperevm rejects forge's gasLimit as "intrinsic gas too low").
is_legacy() {
  case "$1" in hyperevm|metis) return 0 ;; esac
  return 1
}

# Forge sometimes fails to fork because the load-balanced RPC returns null
# for the latest block by number (race / aggressive pruning on fast chains).
# Almost always succeeds on retry.
is_transient_fork_error() {
  echo "$1" | grep -qE 'could not instantiate forked environment|failed to get block for block number'
}

# ─── Main ─────────────────────────────────────────────────────────────────────

echo "Allocator:        $ALLOCATOR"
echo "Depository owner: $DEPOSITORY_OWNER"
echo "Salt:             ${SALT:-1 (default)}"
echo "Mode:             $( $EXECUTE && echo EXECUTE || echo "DRY RUN" )"
echo "Chains:           ${TARGET_CHAINS[*]}"
echo ""

if ! $EXECUTE; then
  echo "Dry run — pass --execute to deploy"
  exit 0
fi

FAILED=()

for slug in "${TARGET_CHAINS[@]}"; do
  if ! rpc="$(rpc_url "$slug")"; then
    FAILED+=("$slug (no RPC)")
    continue
  fi
  profile="$( is_london "$slug" && echo london || echo default )"

  echo ""
  printf '%0.s─' {1..60}; echo
  echo "Deploying: $slug"
  echo "RPC:       $rpc"
  printf '%0.s─' {1..60}; echo

  forge_args=(
    script script/RelayDepositoryDeployer.s.sol:RelayDepositoryDeployer
    --rpc-url "$rpc"
    --slow --broadcast --skip-simulation
    --private-key "$PK"
  )
  is_legacy "$slug" && forge_args+=(--legacy)

  forge_env=(
    ALLOCATOR="$ALLOCATOR"
    CREATE2_FACTORY="$CREATE2_FACTORY"
    DEPOSITORY_OWNER="$DEPOSITORY_OWNER"
    FOUNDRY_PROFILE="$profile"
  )
  [[ -n "$SALT" ]] && forge_env+=(DEPOSITORY_SALT="$SALT")

  # Retry transient fork errors up to 3 times.
  attempt=1
  max_attempts=3
  exit_code=1
  while (( attempt <= max_attempts )); do
    set +e
    output="$(cd "$DEPOSITORY_DIR" && env -u ETHERSCAN_API_KEY "${forge_env[@]}" \
      timeout "$TIMEOUT_SECS" \
      forge "${forge_args[@]}" 2>&1)"
    exit_code=$?
    set -e
    echo "$output"
    if [[ $exit_code -eq 0 ]]; then break; fi
    if (( attempt < max_attempts )) && is_transient_fork_error "$output"; then
      echo "↻ transient fork error — retrying ($((attempt+1))/$max_attempts)"
      attempt=$((attempt+1))
      sleep 3
      continue
    fi
    break
  done

  if [[ $exit_code -eq 124 ]]; then
    echo ""
    echo "✗ $slug — timed out after ${TIMEOUT_SECS}s"
    FAILED+=("$slug (timeout)")
  elif [[ $exit_code -ne 0 ]]; then
    echo ""
    echo "✗ $slug — failed (exit $exit_code)"
    FAILED+=("$slug")
  else
    echo ""
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
