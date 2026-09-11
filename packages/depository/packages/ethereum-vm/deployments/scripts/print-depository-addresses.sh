#!/usr/bin/env bash
set -euo pipefail

trap 'echo; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPOSITORY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NETWORKS_DIR="$(cd "$DEPOSITORY_DIR/../../../networks/src/networks" && pwd)"
cd "$DEPOSITORY_DIR"

# Print the deployed RelayDepository address for each staging EVM chain by
# extracting it from the Foundry broadcast manifests written by
# deploy-depositories.sh.
#
# Equivalent to running, for every chain:
#   jq -r '.transactions[] | select(.contractName == "RelayDepository") | .contractAddress' \
#     broadcast/RelayDepositoryDeployer.s.sol/<chainId>/run-latest.json | head -n1
#
# chainIds are resolved locally from packages/networks/src/networks/*.ts so the
# script doesn't need RPC URLs to run by default.
#
# A broadcast file only proves the deploy *transaction* was sent, not that
# bytecode landed. Pass --check-code to additionally query each chain's RPC
# (cast code) and flag addresses with no contract code as `no-code`.
#
# Run from the depository ethereum-vm package:
#   cd packages/depository/packages/ethereum-vm
#   ./deployments/scripts/print-depository-addresses.sh
#   ./deployments/scripts/print-depository-addresses.sh --chains arbitrum,base
#   ./deployments/scripts/print-depository-addresses.sh --check-code
#   ./deployments/scripts/print-depository-addresses.sh --format env > addresses.env
#
# Formats:
#   table  (default) — aligned columns: slug, chainId, address, status
#   csv             — slug,chainId,address (only `ok` rows)
#   env             — DEPOSITORY_<SLUG_UPPERCASE>=<address> (only `ok` rows)
#
# With --check-code:
#   Loads .env (same RPC_<SLUG_UPPERCASE> vars as deploy/verify scripts) and
#   uses `cast code` to verify on-chain bytecode. Rows fall through to:
#     ok         — broadcast + code on-chain
#     no-code    — broadcast says deployed at addr X, addr X has no code
#     no-rpc     — RPC env var missing, can't check
#     rpc-error  — cast code call failed

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
FORMAT="table"
CHECK_CODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chains)     CHAINS_ARG="$2"; shift 2 ;;
    --format)     FORMAT="$2";     shift 2 ;;
    --check-code) CHECK_CODE=true; shift   ;;
    -h|--help)
      sed -n '11,40p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$FORMAT" in
  table|csv|env) ;;
  *) echo "Error: --format must be one of: table, csv, env" >&2; exit 1 ;;
esac

if $CHECK_CODE && ! command -v cast >/dev/null 2>&1; then
  echo "Error: --check-code requires foundry's \`cast\` on PATH" >&2
  exit 1
fi

# ─── Constants ────────────────────────────────────────────────────────────────

# Same default list as deploy-depositories.sh / verify-depositories.sh.
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
deployed_address() {
  local chain_id="$1"
  local broadcast_file="broadcast/RelayDepositoryDeployer.s.sol/${chain_id}/run-latest.json"
  [[ -f "$broadcast_file" ]] || return 1
  jq -r '.transactions[] | select(.contractName == "RelayDepository") | .contractAddress' \
    "$broadcast_file" | head -n1
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

# Collect all rows first so we can right-pad the table cleanly.
ROWS=()
MISSING=()

for slug in "${TARGET_CHAINS[@]}"; do
  if ! chain_id="$(chain_id_for_slug "$slug")"; then
    ROWS+=("$slug|?|-|unknown-slug")
    MISSING+=("$slug (unknown slug)")
    continue
  fi

  if ! addr="$(deployed_address "$chain_id")" || [[ -z "$addr" ]]; then
    ROWS+=("$slug|$chain_id|-|no-broadcast")
    MISSING+=("$slug ($chain_id)")
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
      check_code "$rpc" "$addr"
      rc=$?
      set -e
      case $rc in
        0) status="ok";        printf 'ok\n' >&2 ;;
        1) status="no-code";   printf 'NO CODE at %s\n' "$addr" >&2
           MISSING+=("$slug ($chain_id) — no code at $addr") ;;
        2) status="rpc-error"; printf 'rpc error\n' >&2
           MISSING+=("$slug ($chain_id) — rpc error") ;;
      esac
    fi
  fi

  ROWS+=("$slug|$chain_id|$addr|$status")
done

case "$FORMAT" in
  csv)
    echo "slug,chainId,address"
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid addr status <<< "$row"
      [[ "$status" == "ok" ]] && echo "$slug,$cid,$addr"
    done
    ;;

  env)
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid addr status <<< "$row"
      [[ "$status" == "ok" ]] && echo "DEPOSITORY_$(upper "$slug")=$addr"
    done
    ;;

  table)
    # Compute column widths.
    w_slug=4; w_cid=7
    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid _addr _status <<< "$row"
      (( ${#slug} > w_slug )) && w_slug=${#slug}
      (( ${#cid}  > w_cid  )) && w_cid=${#cid}
    done

    printf "%-${w_slug}s  %-${w_cid}s  %-42s  %s\n" "slug" "chainId" "address" "status"
    printf "%-${w_slug}s  %-${w_cid}s  %-42s  %s\n" \
      "$(printf '%*s' "$w_slug" '' | tr ' ' '-')" \
      "$(printf '%*s' "$w_cid"  '' | tr ' ' '-')" \
      "$(printf '%*s' 42        '' | tr ' ' '-')" \
      "------"

    for row in "${ROWS[@]}"; do
      IFS='|' read -r slug cid addr status <<< "$row"
      printf "%-${w_slug}s  %-${w_cid}s  %-42s  %s\n" "$slug" "$cid" "$addr" "$status"
    done

    echo ""
    total="${#TARGET_CHAINS[@]}"
    ok_count=0
    for row in "${ROWS[@]}"; do
      IFS='|' read -r _slug _cid _addr status <<< "$row"
      [[ "$status" == "ok" ]] && ok_count=$((ok_count + 1))
    done
    if $CHECK_CODE; then
      echo "Verified: ${ok_count}/${total} with code on-chain"
    else
      echo "Found: ${ok_count}/${total} with broadcast records"
    fi
    if (( ${#MISSING[@]} > 0 )); then
      echo "Issues:"
      for m in "${MISSING[@]}"; do echo "  - $m"; done
    fi
    ;;
esac
