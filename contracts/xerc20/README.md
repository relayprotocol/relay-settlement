# xERC20

xUSDC is the unified USDC token on the Relay chain. It is one `XERC20` token
backed by one `XERC20Lockbox` per origin USDC Hub token. A lockbox `deposit`
takes its Hub USDC and mints xUSDC 1:1. A lockbox `withdraw` burns xUSDC and
returns that USDC. All amounts use raw 6-decimal units. xUSDC reports 18
decimals but does not scale.

The Gateway lockbox is the major lockbox and bypasses the mint and burn limits.
The other lockboxes are minors with limits that the governor can lower, or set
to zero to pause one lockbox.

| Environment | Hub chain ID | Major lockbox   |
| ----------- | ------------ | --------------- |
| dev         | `537724`     | Polygon Gateway |
| stag        | `537713`     | Arc Gateway     |
| prod        | `537713`     | Arc Gateway     |

## Layout

| Path                        | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `contracts/`, `interfaces/` | Upstream `XERC20`, `XERC20Factory` and `XERC20Lockbox` |
| `script/`                   | `DeployLockboxes` deployment script                    |
| `test/`                     | Upstream unit tests and Relay lockbox tests            |
| `deployments/configs/`      | Deployment inputs per token, named after the token     |
| `deployments/contracts/`    | Deployed addresses per environment                     |

## Build and test

From this directory:

```sh
forge soldeer install
forge build
forge test
```

The Foundry configuration pins the compiler settings of the deployed
contracts: Solidity 0.8.23, via IR, 10000 optimizer runs and the Shanghai EVM.
Soldeer pins the dependency Git commits in `foundry.toml` and `soldeer.lock`.
Prettier ignores this project, so the upstream sources and the deployment
inputs stay unchanged.

## Deployment

`DeployLockboxes` deploys the token and one lockbox per configured token, then
transfers token ownership to the governor. It uses the configured `factory`,
normally the environment's shared factory, or deploys a new factory if the
configuration has none. `run()` records the keccak256 hash of the configuration
file in the manifest, so do not edit deployment parameters of a deployed token.
The dev configs use `https://rpc.testnet.relay.link` for chain `537724`; the
commands below select the actual endpoint through `RPC_URL`.

The recorded dev config hashes were updated when their RPC metadata was changed
to the public URL. Each `deployment.originalConfigHash` preserves the hash of the
original deployment input; `deployment.configHash` matches the checked-in config
used by `check(string,string)`. Original local deployment manifests still refer
to the original config bytes.

Every lockbox other than the major one is a bridge whose mint and burn limits
refill over one day. The optional `mintLimits` and `burnLimits` arrays set them
in raw units, in the order of `tokens`, with 0 for the major lockbox. Without
them, each of these lockboxes gets the largest supported limit,
`type(uint256).max / 2`.

```sh
export DEPLOYMENT_CONFIG=deployments/configs/<token>.json
export DEPLOYMENT_MANIFEST=.deployment/<token>/deployment.json
forge script script/DeployLockboxes.s.sol --sig 'plan()' --rpc-url "$RPC_URL"
```

`plan()` validates the configuration without transactions. `run()` with
`--broadcast` and `DEPLOYER_ADDRESS` deploys and writes the manifest:

```sh
forge script script/DeployLockboxes.s.sol --sig 'run()' --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow --skip-simulation
```

The Relay chain charges more gas than the local EVM simulation, so
`--skip-simulation` takes each gas limit from the node's estimate. `--slow` sends
each transaction after the previous one confirms. If the sequencer rate-limits
the deployer, wait a few seconds and rerun the command with `--resume`.

`check()` verifies the deployed state against the configuration and the
manifest. Record the confirmed addresses under `tokens` in
`deployments/contracts/<env>.json`, which also holds the environment's shared
factory.

`check(string,string)` verifies a recorded token against its record and its configuration:

```sh
forge script script/DeployLockboxes.s.sol --sig 'check(string,string)' <env> <token> --rpc-url "$RPC_URL"
```

Blockscout usually verifies the deployed contracts automatically. If it does
not, verify them with `EXPLORER_URL` set to the configured `explorerUrl`. A new
factory needs no constructor arguments:

```sh
forge verify-contract <factory> contracts/XERC20Factory.sol:XERC20Factory \
  --verifier blockscout --verifier-url "$EXPLORER_URL/api/" --rpc-url "$RPC_URL" --watch
forge verify-contract <xerc20> contracts/XERC20.sol:XERC20 \
  --constructor-args "$(cast abi-encode 'constructor(string,string,address)' <name> <symbol> <factory>)" \
  --verifier blockscout --verifier-url "$EXPLORER_URL/api/" --rpc-url "$RPC_URL" --watch
forge verify-contract <lockbox> contracts/XERC20Lockbox.sol:XERC20Lockbox \
  --constructor-args "$(cast abi-encode 'constructor(address,address,bool)' <xerc20> <token> false)" \
  --verifier blockscout --verifier-url "$EXPLORER_URL/api/" --rpc-url "$RPC_URL" --watch
```

Run the lockbox command once per configured token.

## Provenance

The contracts, interfaces and unit tests come unchanged from
[defi-wonderland/xERC20](https://github.com/defi-wonderland/xERC20) at commit
`da2afabdeb1bad9ccda2f6eb928cd99e852530be`.

## License

MIT, see [LICENSE](./LICENSE).
