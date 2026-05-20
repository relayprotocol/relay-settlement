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

Run `yarn multisig-tools --help` for the full list. Common flows:

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

## Manifest generators

Standalone scripts under `scripts/` produce JSON manifests for common operations. Invoke with `tsx`:

```sh
yarn workspace @relay-settlement/multisig-tools tsx scripts/grant-role.ts
yarn workspace @relay-settlement/multisig-tools tsx scripts/set-allocator.ts
```

Generated manifests land under `transactions/` with a numeric prefix.
