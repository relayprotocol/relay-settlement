# Staging deployment

Procedure to (re)deploy the staging EVM contracts: `RelayDepository` (Foundry,
CREATE2) and `DepositAddressFactory` (Hardhat, CREATE2). Aurora-side contracts
(`RelayAllocator`, `RelayMultisigSigner`) are deployed once and reused.

## Staging contracts (Aurora)

- `RelayAllocator`: `0x910F56Fb797D9c7a978a08e73D7280e67eb81372`
- SAFE: `0xcA970F5c1c9eF7029c3FF1fD10E96F73e50C7CE2`
- multisig signer: `0x71d8bE89D9f2339F0FE9cBA39496C6C9cbFF9da6`

## Create `.env`

In `packages/depository/packages/ethereum-vm/.env`:

```dotenv
DEPLOYER_PRIVATE_KEY=...
ALLOCATOR=<allocator MPC, see step 1>
DEPOSITORY_OWNER=<multisig-signer MPC, see step 1>

# one per chain (slug uppercased)
RPC_ARBITRUM=...
RPC_BASE=...
# ... etc

# optional, for verification
ETHERSCAN_API_KEY=...
```

After editing any `packages/networks/src/networks/*.ts` file, rebuild the
networks package so consumers (Hardhat config, deploy tasks) see the
updated chain definitions:

```bash
yarn workspace @relay-protocol/settlement-networks build
```

## 1. Derive MPC signer addresses

The depository constructor takes `(_owner, _allocator)`. Both must be
NEAR-derived MPC addresses — not Safes, not EOAs — so the depository is
controllable on every chain via Chain Signatures.

```bash
cd smart-contracts

# _allocator: MPC address of the staging RelayAllocator
yarn hardhat allocator:signer-address \
  --network aurora \
  --allocator 0x910F56Fb797D9c7a978a08e73D7280e67eb81372 \
  --family ethereum-vm

# _owner: MPC address of the staging RelayMultisigSigner
yarn hardhat allocator:signer-address \
  --network aurora \
  --allocator 0x15334fe6F1cb0e286E1F9e1268B44E4221E169B7 \
  --family ethereum-vm
```

## 2. Deploy `RelayDepository`

CREATE2 via `0x4e59b44847b379578588920cA78FBf26c0B4956c`. Address depends on
`(salt, _owner, _allocator)` — bump the salt for any redeploy.

```bash
cd packages/depository/packages/ethereum-vm
./deployments/scripts/deploy-depositories.sh --salt 3            # dry run
./deployments/scripts/deploy-depositories.sh --execute --salt 3  # broadcast
```

Filter chains with `--chains slug1,slug2`. Foundry writes broadcast manifests
at `broadcast/RelayDepositoryDeployer.s.sol/<chainId>/run-latest.json`.

## 3. Update networks config

For each chain, set `contracts.stag.depository` in
`packages/networks/src/networks/<slug>.ts` to the deployed address. Print
every deployed address (slug → chainId → address) in one go:

```bash
cd packages/depository/packages/ethereum-vm
./deployments/scripts/print-depository-addresses.sh
# also: --chains arbitrum,base   --format csv|env
# verify on-chain bytecode (broadcast file alone doesn't prove deploy landed):
./deployments/scripts/print-depository-addresses.sh --check-code
```

Single chain, raw:

```bash
jq -r '.transactions[] | select(.contractName == "RelayDepository") | .contractAddress' \
  broadcast/RelayDepositoryDeployer.s.sol/<chainId>/run-latest.json | head -n1
```

Three address variants: cancun (most), london (`cronos`, `mantle`, `metis`,
`polygon_zkevm`), and zero.

Rebuild the networks package so step 4 picks up the new addresses:

```bash
yarn workspace @relay-protocol/settlement-networks build
```

Verify ownership:

```bash
cd smart-contracts
yarn hardhat depository:check-owners
```

## 4. Deploy `DepositAddressFactory`

Idempotent CREATE2 deploy. Because the depository address is a constructor arg,
the factory address changes automatically when the depository changes.

```bash
cd smart-contracts
./deployments/scripts/deploy-deposit-factories.sh           # all staging chains
./deployments/scripts/deploy-deposit-factories.sh \
  --chains arbitrum,base                                    # subset
```

The task auto-runs `verify:verify` on success. It skips chains where the
deterministic deployer (`0x4e59b44…`) isn't present and any chain whose
network config doesn't have `contracts.stag.depository` set.

## 5. Verify contracts

```bash
# depositories (Foundry)
cd packages/depository/packages/ethereum-vm
./deployments/scripts/verify-depositories.sh

# retry a failed factory verify
cd smart-contracts
npx hardhat verify <factory> <depository> --network <chain>
```

## Notes

- Setting the depository owner to a Safe (only deployed on Aurora) bricks the
  contract on every other chain — that's the failure mode this redeploy fixes.
- `gensyn` (chainId 685689) has no public RPC; set `RPC_685689` / `RPC_GENSYN`.
- `lighter` and `hyperliquid` are excluded from the EVM script (destination-only
  / custom family).
