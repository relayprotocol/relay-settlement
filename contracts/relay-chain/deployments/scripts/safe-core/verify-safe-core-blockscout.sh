#!/usr/bin/env bash
set -euo pipefail

# Publish an existing Safe core deployment to a Blockscout instance using its
# standard JSON verification API. No deployment credentials are required.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMART_CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SAFE_REPOSITORY="https://github.com/safe-fndn/safe-smart-account.git"
SAFE_VERSION="v1.5.0"
SAFE_COMMIT="dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be"
SOLC_VERSION="v0.7.6+commit.7338295f"

SAFE_REPO_DIR="${SAFE_SMART_ACCOUNT_DIR:-}"
SKIP_INSTALL="${SAFE_CORE_SKIP_INSTALL:-0}"
TEMP_DIR=""

usage() {
  echo "Usage: BLOCKSCOUT_URL=https://explorer.example.com \\"
  echo "  HUB_CONTRACTS_PATH=deployments/contracts/<env>.json \\"
  echo "  yarn safe-core:verify-blockscout"
  echo ""
  echo "Optional environment variables:"
  echo "  SAFE_SMART_ACCOUNT_DIR   Existing pinned Safe checkout"
  echo "  SAFE_CORE_SKIP_INSTALL=1 Reuse an already built checkout"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 1
fi

: "${BLOCKSCOUT_URL:?set BLOCKSCOUT_URL to the explorer origin}"
: "${HUB_CONTRACTS_PATH:?set HUB_CONTRACTS_PATH to the hub contracts file}"

for command in curl git node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

BLOCKSCOUT_URL="${BLOCKSCOUT_URL%/}"
if [[ "$BLOCKSCOUT_URL" == */api || "$BLOCKSCOUT_URL" == */api/v2 ]]; then
  echo "BLOCKSCOUT_URL must be the explorer origin, without /api or /api/v2." >&2
  exit 1
fi

if [[ "$HUB_CONTRACTS_PATH" = /* ]]; then
  DEPLOYMENT_PATH="$HUB_CONTRACTS_PATH"
else
  DEPLOYMENT_PATH="$SMART_CONTRACTS_DIR/$HUB_CONTRACTS_PATH"
fi
if [[ ! -f "$DEPLOYMENT_PATH" ]]; then
  echo "Hub contracts file not found: $DEPLOYMENT_PATH" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -z "$SAFE_REPO_DIR" ]]; then
  TEMP_DIR="$(mktemp -d /tmp/relay-safe-core-blockscout.XXXXXX)"
  SAFE_REPO_DIR="$TEMP_DIR/safe-smart-account"
  git clone --depth 1 --branch "$SAFE_VERSION" \
    "$SAFE_REPOSITORY" "$SAFE_REPO_DIR"
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
  echo "The safe-smart-account checkout has tracked changes." >&2
  exit 1
fi

if [[ "$SKIP_INSTALL" != "1" ]]; then
  npm --prefix "$SAFE_REPO_DIR" ci
fi

BUILD_INFO_DIR="$SAFE_REPO_DIR/build/artifacts/build-info"
mapfile -t BUILD_INFO_FILES < <(find "$BUILD_INFO_DIR" -maxdepth 1 \
  -type f -name '*.json' -print 2>/dev/null | sort)
if [[ ${#BUILD_INFO_FILES[@]} -ne 1 ]]; then
  echo "Expected one Safe build-info file in $BUILD_INFO_DIR; found ${#BUILD_INFO_FILES[@]}." >&2
  echo "Run npm ci in the pinned Safe checkout before using SAFE_CORE_SKIP_INSTALL=1." >&2
  exit 1
fi

STANDARD_INPUT="$SAFE_REPO_DIR/build/safe-v1.5.0-standard-input.json"
node - "${BUILD_INFO_FILES[0]}" "$STANDARD_INPUT" "$SOLC_VERSION" <<'NODE'
const fs = require("fs")
const [buildInfoPath, outputPath, expectedCompiler] = process.argv.slice(2)
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"))
const compiler = `v${buildInfo.solcLongVersion}`
if (compiler !== expectedCompiler) {
  throw new Error(`Unexpected compiler ${compiler}; expected ${expectedCompiler}`)
}
if (!buildInfo.input?.sources || !buildInfo.input?.settings) {
  throw new Error("Safe build info does not contain standard compiler input")
}
fs.writeFileSync(outputPath, `${JSON.stringify(buildInfo.input)}\n`)
NODE

# Fail before submitting anything if this Blockscout instance does not expose
# the v2 smart-contract verification API.
echo "Checking Blockscout verification API"
curl --fail-with-body --silent --show-error \
  "$BLOCKSCOUT_URL/api/v2/smart-contracts/verification/config" >/dev/null

CONTRACTS_FILE="$SAFE_REPO_DIR/build/safe-v1.5.0-contracts.tsv"
node - "$DEPLOYMENT_PATH" >"$CONTRACTS_FILE" <<'NODE'
const fs = require("fs")
const deployment = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const required = [
  ["CompatibilityFallbackHandler", "compatibilityFallbackHandler"],
  ["CreateCall", "createCall"],
  ["ExtensibleFallbackHandler", "extensibleFallbackHandler"],
  ["MultiSend", "multiSend"],
  ["MultiSendCallOnly", "multiSendCallOnly"],
  ["Safe", "safeSingleton"],
  ["SafeL2", "safeL2Singleton"],
  ["SafeMigration", "safeMigration"],
  ["SafeProxyFactory", "safeProxyFactory"],
  ["SafeToL2Setup", "safeToL2Setup"],
  ["SignMessageLib", "signMessageLib"],
  ["SimulateTxAccessor", "simulateTxAccessor"],
  ["TokenCallbackHandler", "tokenCallbackHandler"],
]
for (const [name, key] of required) {
  const address = deployment.safe?.[key]
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
    throw new Error(`Hub contracts file is missing a valid safe.${key} address`)
  }
  process.stdout.write(`${name}\t${address}\n`)
}
NODE

while IFS=$'\t' read -r contract address; do
  STATUS_FILE="$SAFE_REPO_DIR/build/blockscout-$contract.json"
  status_code="$(curl --silent --show-error --output "$STATUS_FILE" \
    --write-out '%{http_code}' \
    "$BLOCKSCOUT_URL/api/v2/smart-contracts/$address" || true)"
  if [[ "$status_code" == "200" ]] && node - "$STATUS_FILE" <<'NODE'
const fs = require("fs")
try {
  const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  process.exit(status.is_verified === true ? 0 : 1)
} catch {
  process.exit(1)
}
NODE
  then
    echo "$contract is already verified at $address"
    continue
  fi

  echo "Submitting $contract at $address"
  curl --fail-with-body --silent --show-error \
    --request POST \
    --url "$BLOCKSCOUT_URL/api/v2/smart-contracts/$address/verification/via/standard-input" \
    --form "compiler_version=$SOLC_VERSION" \
    --form "contract_name=$contract" \
    --form "files[0]=@$STANDARD_INPUT;type=application/json" \
    --form "autodetect_constructor_args=true" \
    --form "license_type=gnu_lgpl_v3"
  echo
 done <"$CONTRACTS_FILE"

echo "Safe core contracts submitted to Blockscout for verification."
