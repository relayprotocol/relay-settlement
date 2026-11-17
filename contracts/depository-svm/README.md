# Solana VM Relay Depository

Anchor programs for custody and forwarding on Solana.

## Programs

- `relay-depository` receives SOL and SPL-token deposits and executes
  allocator-authorized transfers. A routed transfer
  (`execute_transfer_routed`) additionally requires the signature of the
  router program named in the request, so it only executes inside that
  router's instruction (see `../router-svm`).
- `relay-forwarder` forwards deposits into the depository flow.

Program IDs for localnet, devnet, and mainnet are committed in `Anchor.toml` and
in each program's `declare_id!` declaration. Changing one is a deployment
change, not a normal local setup step.

Initialization sets the domain separator, which is required for transfers.
The one-time `migrate_domain_separator` instruction has been retired after
production migrations completed. Existing migrated accounts retain their
layout and domain separator. Legacy accounts must be migrated using a program
version that still supports migration before upgrading to this version.

## Toolchain

The committed Rust crates and JavaScript client use Anchor 0.30.1. The known
working development toolchain is:

- Anchor CLI 0.30.1
- Solana CLI 1.18.18
- Node.js 22
- Yarn 4.9.1 through Corepack

Install the matching Anchor CLI with Cargo if it is not already available:

```sh
cargo install \
  --git https://github.com/coral-xyz/anchor \
  --tag v0.30.1 \
  anchor-cli \
  --locked
```

Verify the active tools before building:

```sh
anchor --version
solana --version
node --version
yarn --version
```

## Build and test

From the repository root:

```sh
corepack enable
cd contracts/depository-svm
yarn install
anchor build
yarn build:fixtures
anchor test
```

`yarn build:fixtures` builds `tests/fixtures/routed-transfer-caller`, a
test-only program that `Anchor.toml` loads into the test validator to call
`execute_transfer_routed` the way a router does. It is not part of the program
workspace.

`anchor test` starts a local validator, deploys the two programs, and runs
the TypeScript integration tests under `tests/`. If a validator is already
running, reuse it with:

```sh
anchor test --skip-local-validator
```

The test scripts declared in `Anchor.toml` can also target the depository or
forwarder suite individually after the programs have been built and deployed.

## Troubleshooting

If the test runner cannot obtain a recent blockhash, inspect
`.anchor/test-ledger/test-ledger-log.txt`. Stop a stale local validator or start
one explicitly with `solana-test-validator`, then rerun with
`--skip-local-validator`.

For `DeclaredProgramIdMismatch`, compare `anchor keys list`, the selected
cluster in `Anchor.toml`, and the relevant program's `declare_id!`. Do not edit
committed program IDs unless the change is part of an intentional deployment.

## Layout

```text
depository-svm/
├── Anchor.toml
├── Cargo.toml
├── programs/
│   ├── relay-depository/
│   └── relay-forwarder/
└── tests/
    ├── fixtures/
    │   └── routed-transfer-caller/
    ├── relay-depository.ts
    ├── relay-forwarder.ts
    ├── routed-transfer.ts
    ├── signature-validation.ts
    └── transfer-checks.ts
```
