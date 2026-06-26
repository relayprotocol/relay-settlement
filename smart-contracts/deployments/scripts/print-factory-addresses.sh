#!/usr/bin/env bash
set -euo pipefail

trap 'echo; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMART_CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$SMART_CONTRACTS_DIR/.." && pwd)"
NETWORKS_DIR="$REPO_ROOT/packages/networks/src/networks"
DEPOSITORY_BROADCAST_DIR="$REPO_ROOT/packages/depository/packages/ethereum-vm/broadcast/RelayDepositoryDeployer.s.sol"
ARTIFACT="$SMART_CONTRACTS_DIR/artifacts/contracts/DepositAddressFactory.sol/DepositAddressFactory.json"

cd "$SMART_CONTRACTS_DIR"

# Print the deployed RelayDepository address and the deterministic
# DepositAddressFactory address for each staging EVM chain.
#
# Depository: read from the Foundry broadcast manifests written by
# deploy-depositories.sh.
# Factory:    computed locally via CREATE2(salt, deployer, init_code) — no
# RPC call unless --check-code is passed.
#
#   init_code = factory_bytecode || abi-encode(depository address)
#   salt      = keccak256("relay_deposit_address_factory")
#   deployer  = 0x4e59b44847b379578588920cA78FBf26c0B4956C (Arachnid proxy)
#
# A broadcast / CREATE2 computation only proves intent / math, not deployment.
# Pass --check-code to additionally query each chain's RPC for both addresses
# and flag any with no on-chain code.
#
# Run from the smart-contracts package:
#   cd smart-contracts
#   ./deployments/scripts/print-factory-addresses.sh
#   ./deployments/scripts/print-factory-addresses.sh --chains arbitrum,base
#   ./deployments/scripts/print-factory-addresses.sh --check-code
#   ./deployments/scripts/print-factory-addresses.sh --format env > addresses.env
#
# Formats:
#   table  (default) — aligned columns: slug, chainId, depository, factory, status
#   csv             — slug,chainId,depository,factory (only `ok` rows)
#   env             — DEPOSITORY_<SLUG>= and FACTORY_<SLUG>= pairs (only `ok` rows)
#   md              — GitHub-flavored markdown table (all rows)
#
# With --check-code, status falls through to:
#   ok                  — both addresses have code
#   no-depository-code  — depository missing
#   no-factory-code     — depository OK, factory missing
#   no-code             — both missing
#   no-rpc              — RPC env var missing
#   rpc-error           — cast code call failed

# ─── Load .env (only used by --check-code) ───────────────────────────────────

if [[ -f "$SMART_CONTRACTS_DIR/.env" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    [[ -n "$key" && -z "${!key+x}" ]] && export "$key"="$val"
  done < "$SMART_CONTRACTS_DIR/.env"
fi

# ─── CLI args ─────────────────────────────────────────────────────────────────

CHAINS_ARG=""
FORMAT="table"
CHECK_CODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chains)     CHAINS_ARG="$2"; shift 2 ;;
    --format)     FORMAT="$2";     shift 2 ;;
    --check-code) CHECK_CODE=true; shift   ;;
    -h|--help) sed -n '17,52p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$FORMAT" in
  table|csv|env|md) ;;
  *) echo "Error: --format must be one of: table, csv, env, md" >&2; exit 1 ;;
esac

if ! command -v cast >/dev/null 2>&1; then
  echo "Error: requires foundry's \`cast\` on PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: requires \`jq\` on PATH" >&2
  exit 1
fi
if [[ ! -f "$ARTIFACT" ]]; then
  echo "Error: factory artifact not found at $ARTIFACT" >&2
  echo "Run \`yarn build\` (or \`yarn hardhat compile\`) in smart-contracts first." >&2
  exit 1
fi

# ─── Constants ────────────────────────────────────────────────────────────────

CREATE2_DEPLOYER="0x4e59b44847b379578588920cA78FBf26c0B4956C"
# keccak256("relay_deposit_address_factory") — must match
# tasks/deployments/depositAddressFactory.ts SALT.
SALT="0x4aac964895f9fc42bafa1d2ad8d0ff5a007564e8944c2eed454f1512c1924825"

# Same default list as deploy-depositories.sh / verify-depositories.sh.
DEFAULT_CHAINS=(
  abstract ancient8 anime apechain appchain arbitrum arbitrum_nova arena_z
  avalanche b3 base berachain blast bnb bob boba celo corn cronos cyber degen
  doma ethereal ethereum flow gensyn gnosis gravity gunz hemi hyperevm ink
  katana linea lisk manta mantle megaeth metis mode monad morph mythos
  optimism perennial plasma plume polygon polygon_zkevm rari redstone ronin
  scroll sei shape somnia soneium sonic stable story superposition superseed
  swellchain syndicate taiko tempo unichain worldchain xai zero zircuit
  zksync zora
)

if [[ -n "$CHAINS_ARG" ]]; then
  IFS=',' read -ra TARGET_CHAINS <<< "$CHAINS_ARG"
else
  TARGET_CHAINS=("${DEFAULT_CHAINS[@]}")
fi

# Factory bytecode is shared across chains; only the constructor arg
# (depository) differs. Read once.
FACTORY_BYTECODE="$(jq -r '.bytecode' "$ARTIFACT")"

# ─── Helpers ──────────────────────────────────────────────────────────────────

# tr-based uppercase for Bash 3.2 (macOS default) compatibility
upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

# Resolve chainId from the networks package by looking for `slug: "<slug>"`
# and extracting the numeric `chainId: <n>n,` literal in the same file.
chain_id_for_slug() {
  local slug="$1"
  local file
  file="$(grep -l "slug: \"$slug\"" "$NETWORKS_DIR"/*.ts 2>/dev/null | head -n1)"
  [[ -z "$file" ]] && return 1
  local id
  id="$(grep -E '^\s*chainId:\s*[0-9]+n,' "$file" | head -n1 | grep -oE '[0-9]+')"
  [[ -z "$id" ]] && return 1
  printf '%s' "$id"
}

# Read deployed depository address from the latest forge broadcast file.
deployed_depository() {
  local chain_id="$1"
  local broadcast_file="$DEPOSITORY_BROADCAST_DIR/${chain_id}/run-latest.json"
  [[ -f "$broadcast_file" ]] || return 1
  jq -r '.transactions[] | select(.contractName == "RelayDepository") | .contractAddress' \
    "$broadcast_file" | head -n1
}

# Compute the deterministic factory address from the depository address.
# init_code = factory_bytecode || abi.encode(address depository)
factory_address_for_depository() {
  local depository="$1"
  local encoded init_code
  encoded="$(cast abi-encode 'constructor(address)' "$depository")"
  init_code="${FACTORY_BYTECODE}${encoded#0x}"
  # `cast create2` prints either the bare address or "Address: 0x…" depending
  # on the foundry version. Handle both.
  local out
  out="$(cast create2 --deployer "$CREATE2_DEPLOYER" --salt "$SALT" --init-code "$init_code" 2>/dev/null)"
  printf '%s\n' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -n1
}

# Look up RPC URL for a chain slug from the environment.
rpc_url() {
  local slug="$1"
  local env_key="RPC_$(upper "$slug")"
  printf '%s' "${!env_key:-}"
}

# Check on-chain bytecode at addr via `cast code`.
# Returns:  0 = code present, 1 = no code (0x), 2 = rpc error
check_code() {
  local rpc="$1" addr="$2"
  local code
  code="$(cast code "$addr" --rpc-url "$rpc" 2>/dev/null || true)"
  [[ -z "$code" ]] && return 2
  [[ "$code" == "0x" ]] && return 1
  return 0
}

# ─── Main ─────────────────────────────────────────────────────────────────────

ROWS=()
MISSING=()

for slug in "${TARGET_CHAINS[@]}"; do
  if ! chain_id="$(chain_id_for_slug "$slug")"; then
    ROWS+=("$slug|?|-|-|unknown-slug")
    MISSING+=("$slug (unknown slug)")
    continue
  fi

  if ! depository="$(deployed_depository "$chain_id")" || [[ -z "$depository" ]]; then
    ROWS+=("$slug|$chain_id|-|-|no-depository")
    MISSING+=("$slug ($chain_id) — no depository broadcast")
    continue
  fi

  factory="$(factory_address_for_depository "$depository")"
  if [[ -z "$factory" ]]; then
    ROWS+=("$slug|$chain_id|$depository|-|create2-error")
    MISSING+=("$slug ($chain_id) — cast create2 failed")
    continue
  fi

  status="ok"
  if $CHECK_CODE; then
    rpc="$(rpc_url "$slug")"
    if [[ -z "$rpc" ]]; then
      status="no-rpc"
      MISSING+=("$slug ($chain_id) — RPC_$(upper "$slug") not set")
    else
      printf '… checking %s (%s) ' "$slug" "$chain_id" >&2
      set +e
      check_code "$rpc" "$depository"
      dep_rc=$?
      check_code "$rpc" "$factory"
      fac_rc=$?
      set -e
      # Status = worst of the two checks. Suffix shows which side failed.
      if (( dep_rc == 2 || fac_rc == 2 )); then
        status="rpc-error"
        printf 'rpc error\n' >&2
        MISSING+=("$slug ($chain_id) — rpc error")
      elif (( dep_rc == 1 && fac_rc == 1 )); then
        status="no-code"
        printf 'NO CODE (both)\n' >&2
        MISSING+=("$slug ($chain_id) — no code at depository or factory")
      elif (( dep_rc == 1 )); then
        status="no-depository-code"
        printf 'NO CODE at depository %s\n' "$depository" >&2
        MISSING+=("$slug ($chain_id) — no code at depository $depository")
      elif (( fac_rc == 1 )); then
        status="no-factory-code"
        printf 'NO CODE at factory %s\n' "$factory" >&2
        MISSING+=("$slug ($chain_id) — no code at factory $factory")
      else
        status="ok"
        printf 'ok\n' >&2
      fi
    fi
  fi

  ROWS+=("$slug|$chain_id|$depository|$factory|$status")
done

case "$FORMAT" in
  csv)
    echo "slug,chainId,depository,factory"
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid dep fac status <<< "$row"
      [[ "$status" == "ok" ]] && echo "$slug,$cid,$dep,$fac"
    done
    ;;

  env)
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid dep fac status <<< "$row"
      if [[ "$status" == "ok" ]]; then
        SLUG_UP="$(upper "$slug")"
        echo "DEPOSITORY_${SLUG_UP}=$dep"
        echo "FACTORY_${SLUG_UP}=$fac"
      fi
    done
    ;;

  md)
    echo "| slug | chainId | depository | factory | status |"
    echo "| --- | --- | --- | --- | --- |"
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid dep fac status <<< "$row"
      echo "| $slug | $cid | \`$dep\` | \`$fac\` | $status |"
    done
    ;;

  table)
    w_slug=4; w_cid=7
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid _dep _fac _status <<< "$row"
      (( ${#slug} > w_slug )) && w_slug=${#slug}
      (( ${#cid}  > w_cid  )) && w_cid=${#cid}
    done

    printf "%-${w_slug}s  %-${w_cid}s  %-42s  %-42s  %s\n" \
      "slug" "chainId" "depository" "factory" "status"
    printf "%-${w_slug}s  %-${w_cid}s  %-42s  %-42s  %s\n" \
      "$(printf '%*s' "$w_slug" '' | tr ' ' '-')" \
      "$(printf '%*s' "$w_cid"  '' | tr ' ' '-')" \
      "$(printf '%*s' 42        '' | tr ' ' '-')" \
      "$(printf '%*s' 42        '' | tr ' ' '-')" \
      "------"

    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid dep fac status <<< "$row"
      printf "%-${w_slug}s  %-${w_cid}s  %-42s  %-42s  %s\n" \
        "$slug" "$cid" "$dep" "$fac" "$status"
    done

    echo ""
    total="${#TARGET_CHAINS[@]}"
    ok_count=0
    for row in "${ROWS[@]}"; do
      IFS='|' read -r _slug _cid _dep _fac status <<< "$row"
      [[ "$status" == "ok" ]] && ok_count=$((ok_count + 1))
    done
    if $CHECK_CODE; then
      echo "Verified: ${ok_count}/${total} with depository + factory code on-chain"
    else
      echo "Computed: ${ok_count}/${total} from depository broadcasts"
    fi
    if (( ${#MISSING[@]} > 0 )); then
      echo "Issues:"
      for m in "${MISSING[@]}"; do echo "  - $m"; done
    fi
    ;;
esac
