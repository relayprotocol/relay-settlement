# Safe core deployment

This directory contains scripts for Safe Smart Account infrastructure deployed
on Relay-supported EVM chains. Deployments use ordinary contract-creation
transactions and intentionally have noncanonical addresses. The addresses are
stored under `safe` in the matching `deployments/contracts/*.json` file.

## Pinned release

- Repository: <https://github.com/safe-fndn/safe-smart-account>
- Version: `v1.5.0`
- Commit: `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be`

Do not change the Safe source or compiler settings. Even a comment change can
change deployment bytecode.

## Deploy

Set deployment credentials through the environment. Never add them to this
repository:

```sh
cd smart-contracts

RPC_URL="https://..." \
PK="0x..." \
yarn safe-core:deploy
```

The wrapper clones the pinned upstream release, runs `npm ci`, and deploys all
13 contracts with ordinary `CREATE` transactions: both Safe singletons, the
proxy factory, handlers, libraries, accessor, setup helper, and migration
contract. It does not deploy or depend on the Safe singleton factory.

The resulting addresses depend on the deployer account and its nonce. The
wrapper independently verifies source and runtime bytecode and writes them
under `safe` in the contracts file whose `chainId` matches the RPC. Set
`HUB_CONTRACTS_PATH` to select that file explicitly. It is required when
multiple environments share a chain ID, such as `stag.json` and `prod.json`.
Subsequent runs verify and reuse a complete `safe` entry instead of deploying
another suite.

Use an existing clean checkout to avoid installing upstream dependencies on
every run:

```sh
RPC_URL="https://..." PK="0x..." \
HUB_CONTRACTS_PATH="deployments/contracts/prod.json" \
yarn safe-core:deploy --safe-repo /path/to/safe-smart-account --skip-install
```

To also create an idempotent 1-of-1 Safe and check its owner, threshold, and
singleton, provide an explicit salt:

```sh
RPC_URL="https://..." PK="0x..." SAFE_SMOKE_TEST_SALT_NONCE=1 \
yarn safe-core:deploy --smoke-test
```

Set `SAFE_SMOKE_TEST_DRY_RUN=1` to calculate the Safe address and validate the
initializer without broadcasting the proxy deployment.

## Resume an interrupted deployment

Rerun `safe-core:deploy` with the same deployment account and contracts
file. The deployer scans its recent `CREATE` nonces, verifies any contiguous
Safe suite prefix against the pinned bytecode, regenerates temporary metadata,
and deploys only the missing contracts. A suite already recorded by another
deployment environment on the same chain is never reused.

Deployment transactions use twice the RPC gas estimate by default to account
for chains whose estimate is too low. Override the multiplier in basis points
when necessary, for example `SAFE_CORE_GAS_MULTIPLIER_BPS=25000` for 2.5x.

## Verify an existing deployment

Verification reads the `safe` entry from the contracts file matching the
RPC chain. It fails if an address has no code, the Safe version is wrong, or the
proxy factory is invalid:

```sh
RPC_URL="https://..." \
HUB_CONTRACTS_PATH="deployments/contracts/<env>.json" \
yarn safe-core:verify
```

`HUB_CONTRACTS_PATH` is optional when exactly one contracts file matches the
RPC chain ID.

`safe-core:verify-source` is the local source-code verification step used by
the deployment wrapper. It recompiles the pinned source using the original
deployment metadata and exact compiler, then compares it with the on-chain
runtime. It is intentionally retained as an independent deployment-time
security check.

## Publish an existing deployment to Blockscout

Blockscout is the supported explorer verification target. The command does not
require deployment credentials or the original
deployment metadata. It rebuilds the pinned release, creates the standard JSON
compiler input, and submits all 13 contracts in the `safe` entry to
Blockscout's v2 verification API:

```sh
BLOCKSCOUT_URL="https://explorer.example.com" \
HUB_CONTRACTS_PATH="deployments/contracts/<env>.json" \
yarn safe-core:verify-blockscout
```

`BLOCKSCOUT_URL` must be the explorer origin without `/api` or `/api/v2`. The
Blockscout smart-contract verification service must be enabled. Already
verified contracts are skipped.

To reuse an existing clean, built Safe checkout:

```sh
BLOCKSCOUT_URL="https://explorer.example.com" \
HUB_CONTRACTS_PATH="deployments/contracts/<env>.json" \
SAFE_SMART_ACCOUNT_DIR="/path/to/safe-smart-account" \
SAFE_CORE_SKIP_INSTALL=1 \
yarn safe-core:verify-blockscout
```

## Protocol Kit configuration

These addresses are not registered with Safe and will not be discovered by
Safe's hosted services or third-party tooling. Provide the addresses from the
`safe` entry to Protocol Kit through its `contractNetworks` configuration.

## Files

- `deploy-safe-core.sh` orchestrates deployment and verification.
- `deploy-safe-core-noncanonical.ts` deploys the 13 contracts with `CREATE`.
- `verify-safe-core.ts` validates runtime code and updates contracts files.
- `verify-safe-core-source.ts` recompiles and compares exact source bytecode.
- `verify-safe-core-blockscout.sh` publishes an existing suite to Blockscout.
- `smoke-test-safe-core.ts` deploys and validates a test Safe proxy.
- `safe-core-common.ts` contains shared deployment and validation helpers.
