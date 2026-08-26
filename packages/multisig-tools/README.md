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
- `RPC_URL` — overrides the canonical RPC resolved from `@relay-protocol/settlement-networks`.

## Subcommands

Run `yarn workspace @relay-settlement/multisig-tools cli --help` for the full list. The Safe-flow subcommands
(`submit`, `check-hashes`, `approve-local`, `execute-transactions`) resolve the
`RelayMultisigSigner` contract from the `--network` config for the `prod` env by
default — pass `--env dev` or `--env stag` to target those deployments instead
(or override the address directly with `--relay-multisig-signer`). Common flows:

```sh
# Simulate every transaction in a manifest (pure offline build + hash check)
yarn multisig:simulate --transactions ./transactions/042-set-allocator.json

# Submit a manifest to the Safe transaction service
yarn multisig:submit --network base --transactions ./transactions/042-set-allocator.json

# Verify the hashes inside a pending Safe transaction match what the manifest produces
yarn multisig:check --network base \
  --transactions ./transactions/042-set-allocator.json \
  --safe-transaction-nonce 17

# Execute (broadcast) the signed transactions on their destination chains
yarn multisig:execute --network base --transactions ./transactions/042-set-allocator.json
```

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

Generated manifests land under `transactions/<env>/` (`dev`, `stag`, or `prod`)
with a per-env numeric prefix. `getManifestPath` defaults to `prod`; env-specific
generators pass their env explicitly.
