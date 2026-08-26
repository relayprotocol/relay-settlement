# Solana VM Relay Depository

Anchor programs for custody, forwarding, and deterministic deposit addresses
on Solana.

## Programs

- `relay-depository` receives SOL and SPL-token deposits and executes
  allocator-authorized transfers.
- `relay-forwarder` forwards deposits into the depository flow.
- `deposit-address` manages deterministic deposit addresses used by the
  deposit-address signing flow.

Program IDs for localnet, devnet, and mainnet are committed in `Anchor.toml` and
in each program's `declare_id!` declaration. Changing one is a deployment
change, not a normal local setup step.

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
cd packages/depository/packages/solana-vm
yarn install
anchor build
anchor test
```

`anchor test` starts a local validator, deploys the three programs, and runs
the TypeScript integration tests under `tests/`. If a validator is already
running, reuse it with:

```sh
anchor test --skip-local-validator
```

The test scripts declared in `Anchor.toml` can also target the depository,
forwarder, or deposit-address suite individually after the programs have been
built and deployed.

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
solana-vm/
├── Anchor.toml
├── Cargo.toml
├── programs/
│   ├── deposit-address/
│   ├── relay-depository/
│   └── relay-forwarder/
└── tests/
    ├── deposit-address.ts
    ├── relay-depository.ts
    └── relay-forwarder.ts
```
