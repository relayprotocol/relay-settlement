# @relay-settlement/multisig-tools

Off-chain CLI for the Relay multisig signer. Builds, simulates, submits, checks, and executes
cross-VM transactions (EVM, Bitcoin, Solana, Tron) routed through `RelayMultisigSigner` and a
Gnosis Safe.

## Install

The package lives inside the monorepo Yarn workspace. From the repo root:

```sh
yarn install
yarn workspace @relay-settlement/multisig-tools build
```

## Environment

- `DEPLOYER_PRIVATE_KEY` — 0x-prefixed deployer/proposer private key. `PRIVATE_KEY` honoured as a fallback.
- `SAFE_API_KEY` — required for any subcommand that talks to the Safe transaction service (`submit`, `check-hashes`, `decode-multicall`).
- `RELAY_API_KEY` — optional Relay API key sent as `x-api-key` on funding quote and
  bridge-status requests when `multisig:execute` bridges gas funds via Relay.
- `RPC_URL` — overrides the canonical RPC resolved from `@relay-protocol/settlement-networks`.
- `RPC_OVERRIDES` — comma-separated `fromUrl=toUrl` pairs that override transaction
  manifest RPCs at load time. Each replacement must serve the same chain. For
  dev manifests, use `https://rpc.testnet.relay.link` as the source URL and supply
  your chain `537724` endpoint through the environment.
- `RELAY_MULTISIG_SIGNER` — overrides the signer selected by `--env`; the explicit
  `--relay-multisig-signer` flag takes precedence over this variable.

The fast-finality rate-limiter and Gateway source migration generators default
to `https://rpc.testnet.relay.link` for dev. The rate-limiter generator accepts
`RPC_URL` and writes the override into its output, so restore the canonical URL
before committing a manifest generated with a private endpoint. The migration
generator uses the canonical endpoint directly.

## Subcommands

Run `yarn workspace @relay-settlement/multisig-tools cli --help` for the full list. The Safe-flow subcommands
(`submit`, `check-hashes`, `approve-local`, `execute-transactions`) resolve the
`RelayMultisigSigner` contract from the `--network` config. Pass an explicit
`--env prod`, `--env dev`, `--env stag`, `--env test`, or `--env deployers`, or
override the address directly with `--relay-multisig-signer`. Common flows:

```sh
# Build every transaction and print signing hashes (EVM also checks nonce and estimates gas via RPC)
yarn multisig:simulate --transactions ./transactions/042-set-allocator.json

# Submit a manifest to the Safe transaction service
yarn multisig:submit --env prod --network base --transactions ./transactions/042-set-allocator.json

# Verify the full pending Safe transaction matches what the manifest produces
yarn multisig:check --env prod --network base \
  --transactions ./transactions/042-set-allocator.json \
  --safe-transaction-nonce 17

# Verify an executed Safe transaction, even after its destination nonce is spent
yarn multisig:check --env prod --network base \
  --transactions ./transactions/042-set-allocator.json \
  --safe-transaction-nonce 17 --executed

# Execute (broadcast) the signed transactions on their destination chains
yarn multisig:execute --env prod --network base --transactions ./transactions/042-set-allocator.json
```

`solana-program-upgrade` deploys, initializes, and upgrades a program. The
domain-separator migration step and `--migration-function` option have been
removed; legacy depositories must be migrated before upgrading to the current
program version.
The command requires `--chain-id` to match the deployment's exact chain ID.
For fresh deployments, `--initial-program-path` must support
`initialize(chain_id)`. The command passes that argument and verifies the stored
domain separator before the final upgrade. Existing depositories are also
checked before either program upgrade; missing or mismatched separators stop
the command.

The Aurora `deployers` signer is `0xE5Ee6a6E8D57d1D315D1898c68eA1bc487B6EA92`,
owned by Safe `0x1AC5584d6E9D628DE717e5FC2c8326d0D810454d`. Its derived EVM
sender is `0x463cB782c8dd0a1887b77336DfF74D60F006F56E`, the ApprovalProxy owner.
`--network aurora` selects the signing network; the manifest selects the
destination chain. For the Robinhood recovery, after the corresponding Safe
approval, run from the repository root:

```sh
yarn multisig:execute --env deployers --network aurora \
  --transactions transactions/developers/001-withdraw-robinhood-approval-proxy-usdg.json
```

The manifest path is relative to the multisig-tools workspace. Its folder name
does not select the signer environment. A network without a configured
`deployers` signer fails instead of falling back to the dev signer.

The `test` env (Arbitrum Sepolia Hub, chain 421614) has its own Aurora
`RelayMultisigSigner` `0x192d296616b699E27cD9Cb7142d1ab77Fe41eE3A`, owned by the
same Safe as the dev and stag signers (`0xcA970F5c1c9eF7029c3FF1fD10E96F73e50C7CE2`).
Its derived EVM sender is `0xBB91A3290Cc99B7b5C2c9A9B700C5B89A12A51EB`. Test
manifests live under `transactions/test/`.
`scripts/generate-migrate-test-ownership.ts` hands the test deployment from the
dev council to that sender.

### Nonce conflicts between manifests

`submit` refuses a manifest whose EVM nonce slots are also claimed by another
manifest in the same `transactions/` directory, when those slots are still
unspent on-chain. Two manifests written against the same starting nonce both
pass the per-transaction nonce check while both are pending — whichever Safe
transaction executes first burns the nonce and silently leaves the other
unexecutable, wasting a signing round.

Regenerate the manifest against the current nonce when this fires. Pass
`--allow-nonce-conflict` only when the other manifest is being abandoned.

### Local approval (Safe UI unavailable)

When the Safe web UI or transaction service is down, `approve-local` executes the
`approveSignature` bundle directly on-chain: it builds the same Safe transaction that
`submit` would propose, collects owner signatures locally, and calls `executeTransaction`
against the Safe contract. Provide enough owner keys to meet the Safe threshold via
`SAFE_OWNER_KEYS` (comma-separated) or `DEPLOYER_PRIVATE_KEY`:

```sh
yarn workspace @relay-settlement/multisig-tools cli approve-local \
  --network aurora \
  --relay-multisig-signer <RelayMultisigSigner address> \
  --transactions ./transactions/042-set-allocator.json

# then sign via MPC + broadcast as usual (no Safe involvement from here on)
yarn workspace @relay-settlement/multisig-tools cli execute-transactions \
  --network aurora \
  --relay-multisig-signer <RelayMultisigSigner address> \
  --transactions ./transactions/042-set-allocator.json
```

No `SAFE_API_KEY` is needed for this flow. The executing key pays Aurora gas, and
`execute-transactions` needs wNEAR on Aurora for the Chain Signatures fees.

## Manifest generators

Standalone scripts under `scripts/` produce JSON manifests for common operations. Invoke with `tsx`:

```sh
yarn workspace @relay-settlement/multisig-tools tsx scripts/set-allocator.ts
```

Generated manifests land under `transactions/<env>/` (`dev`, `stag`, `test`, or `prod`)
with a per-env numeric prefix. `getManifestPath` defaults to `prod`; env-specific
generators pass their env explicitly.

`scripts/generate-configure-robinhood-lighter.ts` registers the Robinhood Lighter
`LighterVmPayloadBuilder` under the Relay chain id `robinhood-lighter` and seeds
its USDG route-type and asset-index Config values. It reads the deployed builder
first and refuses to emit anything unless the builder reads the env's Config
store. For a shared, config-driven builder it also writes the depository account
index recorded for the env and app-chain id 466324 to Config; for a legacy
per-deployment builder it instead requires those two values as the builder's
immutables. It defaults to the env's shared `lighterVmPayloadBuilder`, the
builder verify-deployment expects; pass `PAYLOAD_BUILDER` to target the legacy
`robinhoodLighterVmPayloadBuilder`. It skips calls whose on-chain state already
matches:

```sh
ENV=dev yarn workspace @relay-settlement/multisig-tools tsx \
  scripts/generate-configure-robinhood-lighter.ts
```

To freeze addresses on any supported chain, use
`scripts/generate-suspend-addresses.ts`. It derives each address's Hub alias
from the chain's family and the Hub chain id passed in `--hub-chain-id`, and emits one
`RelayAllocator.suspend(alias)` call per alias that is not already suspended.
A suspended alias cannot submit new allocator withdrawals; payloads the
allocator already signed are not cancelled, and Hub operators can still move its
balance (see below).
Pass `--token` to report the aliases' Hub balances and `--deposit-id` to report
the balances of order addresses credited by deposits that carry an order id
(`--deposit-id` requires `--token`; only the current order-address derivation
is probed, so legacy-credited balances read as zero).
Suspension only blocks allocator withdrawals spent by the alias itself.
`RelayExecutor` holds the Hub operator role and can still pull any account's
balance, including a suspended alias or an order address, with an
oracle-signed execute-and-withdraw request; stopping that path needs the oracle
to refuse to sign, or `pause`/`pauseChains` on the allocator. Any other Hub
`OPERATOR_ROLE` holder can also `transferFrom` a suspended alias directly, which
only control of that role prevents.
`--hub-chain-id` must be the chain id the oracle uses for the chain (for
example `tron`), which can differ from the networks package's `hubChainId`.
`--token` is required (unless `--force` is passed) so the id can be checked:
the script refuses to write the manifest, unless `--force` is passed, when a
token has Hub supply under another candidate id but none under the chosen one,
when no `--token` has Hub supply under the chosen id,
or when the target balances are all zero under the chosen id but non-zero under
another candidate:

```sh
yarn workspace @relay-settlement/multisig-tools tsx scripts/generate-suspend-addresses.ts \
  --chain tron --hub-chain-id tron \
  --address TGYx4neFLvi9TTNBUFoCoBn29UtihFT3rq TJzMDTqiuNdKKxmxF9qZoHm2EFwWiU4VPu \
  --token TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
```

`scripts/generate-setup-ethereum-vm-chain.ts` registers an EVM chain's
depository on the Hub so its deposits can be withdrawn: it writes
`ETHEREUM_VM_CHAIN_ID[<chain>]` to Config, then registers the env's
`EthereumVmPayloadBuilder` for `(<chain>, depository)` on the allocator. The
relay chain id is the network slug, and the depository comes from the env's
entry in `@relay-protocol/settlement-networks`. Calls whose state already
matches are skipped, and a conflicting existing value aborts the run. Dev
privileged changes go through the multisig flow like stag/prod:

```sh
ENV=dev CHAIN=megaeth yarn workspace @relay-settlement/multisig-tools tsx \
  scripts/generate-setup-ethereum-vm-chain.ts
```

To recover Hub balances that are still in the order addresses of Relay
requests, use `scripts/generate-hub-recovery-transfers.ts`. This covers
security-council recoveries of stolen or otherwise frozen deposits. For each
request it resolves the deposit through the Relay API and probes the current
and legacy order-address derivations, and refuses unless exactly one funded
account is found. A Hub mint of the exact deposit amount is only used when no
derivation is funded and the operator confirms the account with
`--mint-source <requestId>=<hubAddress>`. It then emits one
`RelayHub.transferFrom` per account, to the recovery account's alias on the
deposit chain. Requests credited to the same account are combined into one
transfer, capped at their combined deposits. EVM, Solana and Tron deposits are supported, one VM per run.
`--expected-total` fails the run unless the planned transfers add up to the
approved total,
and `--dry-run` prints the plan without writing a manifest. Set
`RELAY_API_KEY` to read `GET /requests/v3`. Without it, the deprecated public
v2 endpoint is used. Follow
[`docs/fund-recovery-runbook.md`](../../docs/fund-recovery-runbook.md) for
the approvals required before submitting:

```sh
RELAY_API_KEY=... yarn workspace @relay-settlement/multisig-tools tsx \
  scripts/generate-hub-recovery-transfers.ts --dry-run \
  --label <incident-id> --receiver <recovery account> \
  --request-id <requestId> [<requestId> ...]
```

For ERC-20 ApprovalProxy recoveries, use
`scripts/generate-approval-proxy-withdrawal.ts` with an explicit chain ID, proxy,
token, expected owner, expected full balance in base units, RPC URL, and output
path. It checks on-chain state and estimates the withdrawal before writing the
manifest; it does not sign or broadcast. Add `--recipient <address>` to append
an ERC-20 transfer of exactly `--expected-balance` base units at the next nonce.
The generator simulates the withdrawal and transfer in order, then rechecks
both with their final gas limits. This requires an RPC supporting
`eth_simulateV1`. Run the script with `--help` for all options.

For the Robinhood recovery, regenerate from the repository root:

```sh
yarn workspace @relay-settlement/multisig-tools tsx scripts/generate-approval-proxy-withdrawal.ts \
  --rpc https://rpc.mainnet.chain.robinhood.com --chain-id 4663 \
  --proxy 0xccc88a9d1b4ed6b0eaba998850414b24f1c315be \
  --token 0x5fc5360d0400a0fd4f2af552add042d716f1d168 \
  --expected-owner 0x463cb782c8dd0a1887b77336dff74d60f006f56e \
  --expected-balance 300000000000 \
  --recipient 0xbc46f56c0caac0e934a1c9afaf364701582353b8 \
  --output transactions/developers/001-withdraw-robinhood-approval-proxy-usdg.json
```

The two transactions are ordered, not atomic: withdrawal sends the entire
proxy balance to its owner; the second sends exactly 300,000 USDG to the
recipient. Any later deposits beyond that amount remain with the owner.
Regeneration can change signing hashes and requires new approvals.

For dependent EVM calls, `simulate`, `submit`, `check-hashes`, and `approve-local`
use sequential simulation when standalone gas estimation fails and the
manifest supplies a contiguous unspent prefix from the same sender and RPC.
Execution waits for each receipt and validates the next call against live
state. If a transaction fails, subsequent transactions from that sender are
skipped; inspect the failure before retrying.

### Sign-only messages

Regular manifest arrays can include `family: "message"` entries with an expected
`from` signer, a `description`, and a `message` object. The supported type is
`personal_sign`: `data` is hex-encoded bytes, and the builder applies the EIP-191
prefix to those bytes, not to their hex text. Review the plaintext preimage and
its digest before approving a message; hash comparison alone does not establish
what the message authorizes.

`submit`, `approve-local`, and `check-hashes` use the normal signature approval
flow. `simulate` validates and prints message hashes locally.
`execute-transactions --signatures-output /tmp/signatures.json` collects approved
MPC signatures, verifies their signer, and saves each successful result. Message
entries are never broadcast. The output path must be new; retry partial failures
with a new path to collect cached signatures. Keep artifacts out of the repository.

For staged workflows, use `execute-transactions --indices 0,1` to execute only
those entries, then `--indices 2` for the remaining entry after its prerequisites
are complete. Indices are zero-based, execution preserves manifest order, and
signature artifacts retain their original manifest indices. Entries not selected
are neither signed nor executed. Without `--indices`, all entries are processed.

Execution checks the latest base fee against the approved EIP-1559 cap before
requesting a signature and again before broadcast. If the cap is stale, wait for
fees to fall or regenerate the transaction and obtain new approval and a signature.
For already-signed transactions, `FORCE_BROADCAST=1` bypasses both the latest and
recent base-fee checks in the broadcast helper, allowing broadcast and receipt
waiting while fees are high. It does not bypass the pre-signature check, including
when rerunning `execute-transactions`.

For transactions that depend on external funding or another pending operation,
`submit`, `approve-local`, and `check-hashes` accept `--skip-simulation`. This
skips destination EVM execution simulation when constructing approvals, while
retaining chain and nonce checks. Safe approval calls still undergo their normal
checks. `execute-transactions` does not accept this option and always checks the
live execution state.

### Council verification before signing

Use a fresh build of this checkout for Council verification. Older builds that
print only `All actions match transactions generated from the manifest!` check
only part of the transaction and must not be used to approve a signature.
From the repository root, install the locked dependencies, build the CLI and
its workspace dependencies, and run the verification regression suite:

```sh
yarn install --immutable
yarn workspaces foreach --recursive --topological-dev --from @relay-settlement/multisig-tools run build
yarn workspace @relay-settlement/multisig-tools test test/checkHashes.spec.ts test/safe.spec.ts
yarn multisig:check --env prod --network base \
  --transactions ./transactions/042-set-allocator.json \
  --safe-transaction-nonce 17
```

Replace the network, manifest path and nonce with those of the proposal being
reviewed. Before signing, require `Full Safe transaction matches the manifest!`
and compare the printed Safe transaction hash with the hash being signed.

`check-hashes` reconstructs the transaction through the same Safe SDK path as
`submit`: one approval is a zero-value CALL to the signer; multiple approvals
use a zero-value DELEGATECALL to the SDK's canonical MultiSendCallOnly deployment
for the connected chain and Safe version. Verification compares the outer target,
value, operation, raw calldata, nonce and all gas/refund fields, then checks the
Safe address and transaction hash. MultiSend calldata is decoded locally with
strict checks on its ABI encoding and packed action lengths. Each action must
match the manifest in order, including its target, calldata, zero value and CALL operation.
Reordered approvals require a manifest with the same order.

Missing, ambiguous or inconsistent transaction-service responses and malformed
calldata reject verification. Verification does not call the Safe data-decoder
endpoint, so decoder outages or missing ABI registrations do not block it.
Neither `--skip-simulation` nor `--executed` disables these checks.
`decode-multicall` remains an informational, best-effort decoder
and is not a substitute for verification.

### Checking executed Safe transactions

`check-hashes --executed` searches executed Safe transactions at the supplied
nonce; the default searches unexecuted proposals. The lookup filters by nonce
at the Safe service and refuses ambiguous results. Executed checks skip
destination nonce validation and simulation because current state may have
changed since execution. They still query the destination chain ID, so an
accessible destination RPC is required, even with `--skip-simulation`.

Historical verification currently supports EVM transactions and sign-only
messages. Other families fail before building any entries because their
builders can depend on live block or nonce data. A matching transaction verifies
the manifest's complete Safe approval transaction; it does not establish execution success or current
executability. `execute-transactions` does not accept `--executed` and retains
its normal live-state checks.

### Migrating routed withdrawal routers

The configure and grant helpers accept an optional `routerRollout` section in
`contracts/relay-chain/deployments/contracts/<ENV>.json`. Keep historical tuples there
when replacing `multicallRouters`: overwriting the current router record alone
neither revokes nor verifies the previous allowlist key. The same section can be
supplied as the contents of `ROUTER_ROLLOUT_FILE=/path/to/rollout.json` to both
helpers and the deployment verifier. File entries are **added** to recorded
entries, so an override cannot hide recorded retirements.

```json
{
  "retiredRouters": [
    {
      "chain": "ethereum",
      "depository": "0x1111111111111111111111111111111111111111",
      "router": "0x2222222222222222222222222222222222222222"
    }
  ],
  "gatewayDestinations": [
    {
      "chain": "ethereum",
      "depository": "0x3333333333333333333333333333333333333333",
      "router": "0x4444444444444444444444444444444444444444"
    }
  ]
}
```

These illustrative addresses must be replaced with reviewed deployment addresses.
`chain` is the underlying EVM destination slug and signature domain (for example,
`ethereum`, not a Gateway source slug). `gatewayDestinations` is an explicit list
of destinations where routed Gateway withdrawals are enabled; `depository` is
the separate **Gateway destination** depository that calls the router. The
helpers do not infer this caller from ordinary depository network metadata.
Only known EVM domains and nonzero EVM addresses are accepted. `CHAINS` continues
to select ordinary chains; explicit rollout tuples are always processed.

`gatewayDestinations` entries are only accepted on Gateway destination chains,
and their `depository` must be the Gateway destination depository the relay
chain's Config resolves for that chain: the grant helper refuses to emit a
grant otherwise, the configure helper holds the allowlist write while the
destination depository is unset and aborts on a different address, and the
verifier fails the tuple.
The routed `ethereumVmPayloadBuilder` and the Gateway destination builder derive
identical allowlist and signature-chain keys, so every tuple's keys are read
through the routed builder. The grant and configure helpers refuse a recorded
router that is also listed as retired, whatever `CHAINS` selects, like the
verifier.

1. Record the old `(chain, depository, router)` tuples before updating current
   `multicallRouters`. Include old Gateway tuples as well as ordinary tuples.
2. Deploy the replacement router and run
   `ENV=prod ROUTER_ROLLOUT_FILE=/absolute/path/rollout.json yarn workspace @relay-settlement/multisig-tools tsx scripts/generate-grant-router-depository-role.ts`.
   Review and execute its manifest. It grants ordinary and explicit Gateway
   callers on their destination chains, with consecutive nonces for multiple
   grants on the same chain. Existing grants are skipped.
3. Run
   `ENV=prod ROUTER_ROLLOUT_FILE=/absolute/path/rollout.json yarn workspace @relay-settlement/multisig-tools tsx scripts/generate-configure-routed-withdrawal.ts`.
   Review and execute the ordinary builder-registration manifest first if one
   is produced, then rerun. Config writes remain withheld until registrations
   are confirmed on-chain, and a Gateway router's `1` is withheld until the
   chain's Config destination builder is `gatewayEthereumVmDestinationPayloadBuilder`
   (configure it through the Gateway activation flow, then rerun). The config
   manifest writes current ordinary and Gateway router keys to `1`, historical
   tuple keys to `0`, and signature chain domains for enabled destinations. Gateway entries do not register the
   ordinary payload builder for their separate depository; Gateway builder
   deployment/registration uses the Gateway activation flow.
4. Run the deployment verifier with the same rollout records/file. It checks
   historical keys independently of current routers and requires a successfully
   read **explicit zero** for every retirement. Any nonzero value, unset key, or
   unavailable Config read fails verification; execute the generated zero write
   even when an old key was never set. It checks each explicit Gateway allowlist
   tuple, the Config destination builder for that chain, destination RPC domain,
   router code, caller `DEPOSITORY_ROLE`, and council `ADMIN_ROLE`.
   Retain retirement records for subsequent verification runs. Archive reviewed
   generated transaction manifests before rerunning helpers, which reuse paths.
5. Rebuild each routed withdrawal as one unit: the outer router address, inner
   `settle`/`sweep` `Call.to` targets, principal receiver when the router receives
   native/ERC-20 funds, calldata hash, and signed withdrawal authorization must
   all name/commit to the replacement. Cached inner calls to the old router fail
   `CallerNotSelf`. Mandatory settle/refund/sweep calls and the depository's
   router call must set `allowFailure=false` so failures roll back the withdrawal.
6. Plan pending work before retirement. Setting the Hub allowlist key to zero
   stops future builds; it does **not** invalidate already issued depository
   signatures. Rebuild/re-sign, complete, or expire that signed work under an
   explicit cutoff policy, then revoke the old router's `DEPOSITORY_ROLE` callers
   using destination governance. The helpers intentionally do not guess this
   timing or automatically revoke destination roles.

The helpers only generate manifests and read state; they do not execute the
rollout. Verify the Gateway destination builder is deployed and activated before
using routed Gateway withdrawals.

### Allowlisting Solana routers

`scripts/generate-configure-solana-router-allowlist.ts` writes the
`SolanaVmPayloadBuilder` router allowlist key for each `(chain, depository, router)`
tuple: `VALUE=1` (the default) allows a router program, any other value (use `0`)
revokes it, since Config cannot delete a key. Keys are read from the builder's
`getRouterAllowedKey`, and keys already at `VALUE` are skipped. Several routers may
be allowed at once, so a replacement router can be allowed before the old one is
revoked.

Allowing refuses to emit anything unless the allocator's registered builder for the
chain and depository is `PAYLOAD_BUILDER` (default: the env's
`solanaVmPayloadBuilder`) and that builder has routed mode. A builder without it
signs routed withdrawals as plain transfers to the bundle, which can be executed
without the fill. Register the routed builder first, or set `REGISTER_BUILDER=1` to put
`allocator.setPayloadBuilder` in the same manifest ahead of the allowlist write
(`dev/029` was generated this way). Then run:

```sh
ENV=prod ROUTER=<router program id> yarn workspace @relay-settlement/multisig-tools tsx \
  scripts/generate-configure-solana-router-allowlist.ts
```

`CHAINS` selects solana-vm slugs (default `solana`); `DEPOSITORY` overrides the
recorded depository for a single chain and is required where the env records none.
`DRY_RUN=1` prints the calls without fetching a nonce or writing a manifest;
`RELAY_NONCE_OFFSET` and `SIGNER` behave as in the other relay-chain generators.
Revoking a router stops future builds only: payloads the allocator already signed
stay executable until they expire.
