# EVM Relay Depository

Solidity implementations of the standard Relay depository and the Circle
Gateway-backed depository.

The standard depository's three-parameter `depositErc20(depositor, token, id)`
overload deposits the caller's full allowance and reverts with `AmountCannotBeZero`
when that allowance is zero. This guard applies to new builds; frozen releases
retain their original behavior.

## Build and test

From this directory:

```sh
forge soldeer install
forge build
forge test
```

The Foundry configuration pins Solidity 0.8.28 and disables bytecode metadata.
Soldeer pins the dependency Git commits in `foundry.toml` and `soldeer.lock`.
Run `forge soldeer install` after checkout or dependency changes.
Yarn manages the separate Tron tooling dependencies.

## Standard depository deployment

`deployments/environments/` contains the canonical dev, staging, and production
addresses. Deployments at these addresses **must use the frozen artifacts in
`deployments/releases/`** through the CLI below, with the recorded factory,
salt, and constructor arguments. Compiling the current `src/` contracts or
substituting current owner and allocator addresses will not preserve the
canonical address.

The environment manifests describe bytecode variants independently of the
chain being deployed to. Select `--variant` for the target chain's EVM support
and intended deployment address. Each command targets one RPC and one variant;
`--chain-id` checks the RPC's identity and derives chain-specific runtime
bytecode for verification. No chain list or network registry is required.

Run `yarn install` from the repository root to install the CLI dependencies.

Use `cancun` on Ethereum. First inspect the production release:

```sh
node deployments/depository.mjs plan --env prod --variant cancun
```

This prints the address, bytecode hashes, source snapshot, owner, allocator,
and encoded constructor arguments. It does not make a network request.

Deploy the exact frozen init code to Ethereum:

```sh
DEPLOYER_PRIVATE_KEY=... node deployments/depository.mjs deploy \
  --env prod \
  --variant cancun \
  --chain-id 1 \
  --rpc-url "$ETHEREUM_RPC_URL"
```

`deploy` requires `DEPLOYER_PRIVATE_KEY`. It refuses an RPC with the wrong
chain ID and occupied addresses with different code. Add `--legacy` only when
the target RPC requires legacy transactions. Successful transactions are
recorded under `deployments/receipts/<env>/<chain-id>.json` immediately after
confirmation, before the bytecode check. The receipt records `verification` as
`pending` until the check succeeds. If the RPC is stale or unavailable, rerun
`deploy` to verify the existing deployment and refresh the receipt without
resending a transaction. Existing transaction details are preserved; deployments
first observed by this CLI have null transaction hash and block number.

Verify Ethereum's deployed bytecode and print the current owner and allocator:

```sh
node deployments/depository.mjs verify \
  --env prod \
  --variant cancun \
  --chain-id 1 \
  --rpc-url "$ETHEREUM_RPC_URL"
```

This derives the exact runtime bytecode for chain ID 1 from the frozen template
and Solidity immutable locations, then compares its hash with the on-chain
code. The chain ID matters because `RelayDepository` embeds it in EIP-712
immutables.

### Rebuild and explorer verification

The package contains everything specific to each release:

- exact init code, runtime template, immutable locations, and provenance hash
  in `deployments/releases/`;
- exact historical contract and dependency sources, with their license, in
  `deployments/sources.json`;
- compiler version and settings in each release file;
- factory, salt, constructor values, and address in
  `deployments/environments/`.

Each release's `build.sourceSnapshot` selects a shared snapshot from
`sources.json`. The snapshot stores the original Solidity source paths and
contents as JSON strings, preserving the compiler input without a separate
source directory.

Rebuild a release with the pinned Solidity compiler and require exact init code
and runtime template matches:

```sh
node deployments/depository.mjs build --env prod --variant cancun
```

CI uses `node deployments/depository.mjs build-all` to discover every
environment manifest and rebuild every variant, including newly added releases.

The command finds Solidity 0.8.28 in Foundry's compiler cache. Use
`--solc /path/to/solc-0.8.28` if it is installed elsewhere.

For explorer verification, generate the complete Solidity standard JSON input:

```sh
node deployments/depository.mjs compiler-input \
  --env prod \
  --variant cancun \
  > /tmp/relay-depository-standard-input.json
```

Submit that file with Solidity 0.8.28. `plan` prints the constructor arguments
to submit with it. No other repository or source checkout is required.

### Why canonical deployments use frozen artifacts

CREATE2 derives the deployment address from the factory address, salt, and
hash of the init code. The init code includes both the contract creation
bytecode and the encoded constructor arguments. All of these inputs must
remain identical to reproduce a canonical address on another chain.

The deployed legacy contracts include Solidity CBOR/IPFS metadata. That
metadata contains source hashes, so even a comment or whitespace change can
change the init code and therefore the CREATE2 address. Never rebuild a legacy
release from the current `src/` directory. Use its frozen source snapshot and
bytecode artifact.

The constructor values, factory, salt, original deployment transaction, exact
init code, runtime template, immutable locations, provenance runtime hash, and
historical sources are all recorded in this package. The deployment command
sends the frozen init code; it does not compile during deployment.

The historical constructor owner and allocator may be outdated relative to
the current governance configuration. Keeping those constructor arguments is
intentional: changing either address changes the init code hash and therefore
the CREATE2 address, even if the contract bytecode, factory, and salt stay the
same. Do not update the frozen artifacts or their recorded constructor values
to match current governance.

Instead, deploy the historical artifact to preserve the canonical address,
then update the contract's mutable state. Run `verify` as shown above to inspect
the deployed owner and allocator. If they differ from the intended current
configuration, the owner must call `setAllocator` first and `transferOwnership`
last. These calls update permissions without changing the contract address.
Run `verify` again to confirm the final values before using the deployment.

## Gateway depository deployment

`RelayGatewayDepository` uses chain-independent constructor arguments so the
same CREATE2 factory, salt, owner, and allocator produce the same address on
every EVM chain. Circle Gateway contract addresses are compiled constants
because Circle uses the same addresses across its supported EVM chains.

Compile Gateway deployments with the `london` profile so initialization
bytecode is identical on chains with different EVM support. Both Foundry
profiles disable the Solidity metadata hash and CBOR trailer.

Required configuration:

- `GATEWAY_DEPOSITORY_OWNER`
- `GATEWAY_ALLOCATOR`
- `CREATE2_FACTORY`
- `GATEWAY_DEPOSITORY_SALT` (optional, defaults to `1`)

```sh
FOUNDRY_PROFILE=london forge script \
  ./script/RelayGatewayDepositoryDeployer.s.sol:RelayGatewayDepositoryDeployer \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --create2-deployer "$CREATE2_FACTORY" \
  --no-metadata
```

After deployment, the owner must call `initializeUsdc(address)` once with the
chain's native USDC address. Deposits remain disabled until initialization is
complete.

## Verification and smoke tests

Use `deployments/depository.mjs verify` for standard depositories. Gateway
depositories are not part of the standard release manifests and must be
verified separately with their exact build inputs and constructor values.

After bytecode verification, run
`deployments/scripts/test-deposit-and-withdrawal.js` against each target chain
to exercise a deposit and allocator-authorized withdrawal. This smoke test is
in addition to the local Foundry suite.
