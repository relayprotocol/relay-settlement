# EVM Relay Depository

Solidity implementations of the standard Relay depository and the Circle
Gateway-backed depository.

## Build and test

From this directory:

```sh
forge build
forge test
```

The Foundry configuration pins Solidity 0.8.28 and disables bytecode metadata.
Dependency revisions are committed as Git submodules and in `foundry.lock`.

## Standard depository deployment

Use the multi-chain deployment wrapper for routine deployments. It performs a
dry run unless `--execute` is supplied:

```sh
./deployments/scripts/deploy-depositories.sh --chains arbitrum,base
./deployments/scripts/deploy-depositories.sh --execute --chains arbitrum,base
```

The script documents its required environment variables and derives the
CREATE2 address before broadcasting. At minimum, deployments require the
allocator, depository owner, per-chain RPC URLs, and—with `--execute`—the
deployer private key. Keep secrets in an ignored `.env` file.

The underlying Foundry script is
`script/RelayDepositoryDeployer.s.sol`. Its configuration is:

- `ALLOCATOR`
- `DEPOSITORY_OWNER`
- `CREATE2_FACTORY`
- `DEPOSITORY_SALT` (optional, defaults to `1`)
- `CHAIN` (optional when `--rpc-url` selects the target)

Deploy only from a reviewed, tagged commit. Record the source commit, compiler
profile, constructor arguments, salt, factory, transaction hash, runtime
bytecode hash, and resulting address for each production deployment.

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

Verify standard depositories recorded in Foundry broadcast output with:

```sh
./deployments/scripts/verify-depositories.sh --chains arbitrum,base
```

For explorers not supported directly by Foundry, pass the appropriate verifier
URL and API key to `forge verify-contract`.

After source verification, run
`deployments/scripts/test-deposit-and-withdrawal.js` against each target chain
to exercise a deposit and allocator-authorized withdrawal. This smoke test is
in addition to the local Foundry suite.
