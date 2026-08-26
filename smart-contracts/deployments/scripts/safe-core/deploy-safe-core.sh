#!/usr/bin/env bash
set -euo pipefail

# Deploy the pinned Safe Smart Account release with ordinary CREATE
# transactions. This project intentionally uses noncanonical addresses.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMART_CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SAFE_REPOSITORY="https://github.com/safe-fndn/safe-smart-account.git"
SAFE_VERSION="v1.5.0"
SAFE_COMMIT="dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be"

SAFE_REPO_DIR="${SAFE_SMART_ACCOUNT_DIR:-}"
SKIP_INSTALL=0
RUN_SMOKE_TEST=0
TEMP_DIR=""

usage() {
  echo "Usage: yarn safe-core:deploy [options]"
  echo ""
  echo "Options:"
  echo "  --safe-repo PATH       Use an existing pinned upstream checkout"
  echo "  --skip-install         Do not run npm ci in the upstream checkout"
  echo "  --smoke-test           Deploy and validate a 1-of-1 Safe proxy"
  echo ""
  echo "Environment:"
  echo "  HUB_CONTRACTS_PATH     Hub contracts JSON to update; required when multiple"
  echo "                         environments use the same chain ID"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --safe-repo) SAFE_REPO_DIR="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --smoke-test) RUN_SMOKE_TEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${RPC_URL:?set RPC_URL}"
if [[ "$RUN_SMOKE_TEST" -eq 1 && -z "${SAFE_SMOKE_TEST_SALT_NONCE:-}" ]]; then
  echo "Set SAFE_SMOKE_TEST_SALT_NONCE when using --smoke-test." >&2
  exit 1
fi
cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

run_smoke_test() {
  HUB_CONTRACTS_PATH="$deployment_path" yarn safe-core:smoke-test
}

cd "$SMART_CONTRACTS_DIR"
chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [[ -n "${HUB_CONTRACTS_PATH:-}" ]]; then
  if [[ "$HUB_CONTRACTS_PATH" = /* ]]; then
    deployment_path="$HUB_CONTRACTS_PATH"
  else
    deployment_path="$SMART_CONTRACTS_DIR/$HUB_CONTRACTS_PATH"
  fi
else
  deployment_path="$(node - "$chain_id" "$SMART_CONTRACTS_DIR/deployments/contracts" <<'NODE'
const fs = require("fs")
const path = require("path")
const [chainId, directory] = process.argv.slice(2)
const matches = fs.readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => path.resolve(directory, file))
  .filter((file) => JSON.parse(fs.readFileSync(file, "utf8")).chainId?.toString() === chainId)
if (matches.length === 0) {
  throw new Error(`No hub contracts file matches chain ${chainId}`)
}
if (matches.length > 1) {
  const files = matches.map((file) => path.relative(process.cwd(), file)).join(", ")
  throw new Error(
    `Chain ${chainId} matches multiple hub contracts files: ${files}. ` +
    "Set HUB_CONTRACTS_PATH to the intended environment."
  )
}
process.stdout.write(matches[0])
NODE
)"
fi

if [[ ! -f "$deployment_path" ]]; then
  echo "Hub contracts file not found: $deployment_path" >&2
  exit 1
fi
node - "$deployment_path" "$chain_id" <<'NODE'
const fs = require("fs")
const [deploymentPath, chainId] = process.argv.slice(2)
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
if (deployment.chainId?.toString() !== chainId) {
  throw new Error(`Hub contracts chain ${deployment.chainId} does not match RPC chain ${chainId}`)
}
NODE

echo "Checking for an existing Safe core entry in $deployment_path"
if node - "$deployment_path" <<'NODE'
const fs = require("fs")
const deployment = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
process.exit(deployment.safe && typeof deployment.safe === "object" ? 0 : 1)
NODE
then
  if HUB_CONTRACTS_PATH="$deployment_path" yarn safe-core:verify; then
    echo "The noncanonical Safe core deployment is already present."
    if [[ "$RUN_SMOKE_TEST" -eq 1 ]]; then
      if [[ -z "${PK:-}" && -z "${DEPLOYER_PRIVATE_KEY:-}" && -z "${MNEMONIC:-}" ]]; then
        echo "Set PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC to run the smoke test." >&2
        exit 1
      fi
      run_smoke_test
    fi
    exit 0
  fi
  echo "Existing Safe deployment failed verification; refusing to overwrite $deployment_path." >&2
  exit 1
fi

echo "No complete verified deployment found; preparing deployment."
if [[ -z "${PK:-}" && -z "${DEPLOYER_PRIVATE_KEY:-}" && -z "${MNEMONIC:-}" ]]; then
  echo "Set PK, DEPLOYER_PRIVATE_KEY, or MNEMONIC." >&2
  exit 1
fi

if [[ -z "$SAFE_REPO_DIR" ]]; then
  TEMP_DIR="$(mktemp -d /tmp/relay-safe-core.XXXXXX)"
  SAFE_REPO_DIR="$TEMP_DIR/safe-smart-account"
  git clone --depth 1 --branch "$SAFE_VERSION" "$SAFE_REPOSITORY" "$SAFE_REPO_DIR"
fi

if [[ ! -d "$SAFE_REPO_DIR/.git" ]]; then
  echo "Not a git checkout: $SAFE_REPO_DIR" >&2
  exit 1
fi

actual_commit="$(git -C "$SAFE_REPO_DIR" rev-parse HEAD)"
if [[ "$actual_commit" != "$SAFE_COMMIT" ]]; then
  echo "Unexpected safe-smart-account commit: $actual_commit" >&2
  echo "Expected $SAFE_COMMIT ($SAFE_VERSION)." >&2
  exit 1
fi
if ! git -C "$SAFE_REPO_DIR" diff --quiet || \
   ! git -C "$SAFE_REPO_DIR" diff --cached --quiet; then
  echo "The safe-smart-account checkout has tracked changes; refusing deployment." >&2
  exit 1
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  npm --prefix "$SAFE_REPO_DIR" ci
fi

echo "Deploying noncanonical Safe core $SAFE_VERSION from $SAFE_COMMIT"
SAFE_SMART_ACCOUNT_DIR="$SAFE_REPO_DIR" \
SAFE_DEPLOYMENTS_DIR_OUT="$SAFE_REPO_DIR/deployments/custom" \
HUB_CONTRACTS_PATH="$deployment_path" \
  yarn safe-core:deploy-noncanonical

# Independently check the deployed runtime before recording the addresses.
cd "$SMART_CONTRACTS_DIR"
SAFE_DEPLOYMENTS_DIR="$SAFE_REPO_DIR/deployments/custom" \
HUB_CONTRACTS_PATH="$deployment_path" \
WRITE_SAFE_CORE_DEPLOYMENT=1 \
  yarn safe-core:verify

SAFE_DEPLOYMENTS_DIR="$SAFE_REPO_DIR/deployments/custom" \
SAFE_SMART_ACCOUNT_DIR="$SAFE_REPO_DIR" \
  yarn safe-core:verify-source

if [[ "$RUN_SMOKE_TEST" -eq 1 ]]; then
  run_smoke_test
fi

echo "Safe core deployment complete. Commit the updated hub contracts file."
