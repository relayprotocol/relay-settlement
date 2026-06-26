# @relay-protocol/lit-actions

Helpers for loading the Lit Actions used by Relay.

## API

This package exposes two helpers:

```ts
getAllocatorAction(environment, version, vmType)
getDepositAddressAction(environment, version, vmType)
```

Each returns:

- `code` — the bundled JavaScript source for the corresponding action
- `config` — the environment config bundled into this package

## Types

`vmType` uses `VmType` from `@relay-protocol/settlement-sdk`.

Types exported by this package:

- `AllocatorActionEnvironment`, `AllocatorActionVersion`, `AllocatorActionConfig`, `AllocatorAction`
- `DepositAddressActionEnvironment`, `DepositAddressActionVersion`, `DepositAddressActionConfig`, `DepositAddressAction`

## Supported values

Allocator actions:

- `environment`: `dev`, `stag`, `prod`
- `version`: `v1`
- `vmType`: `ethereum-vm`, `solana-vm` (and `ton-vm` for `dev`)

Deposit-address actions:

- `environment`: `dev`
- `version`: `v1`
- `vmType`: `ethereum-vm`, `solana-vm`, `bitcoin-vm`, `hyperliquid-vm`

If a version, environment, or VM type is missing, the helper throws.

## Example

```ts
import { getAllocatorAction } from "@relay-protocol/lit-actions"
import { VmType } from "@relay-protocol/settlement-sdk"

const vmType: VmType = "ethereum-vm"
const action = getAllocatorAction("dev", "v1", vmType)

console.log(action.code)
console.log(action.config)
```

## How the action code is produced

The action sources are **not** vendored into this package. They live in the
source packages, each with its own tested esbuild bundler:

- `@relay-protocol/lit-allocator` — allocator actions
- `@relay-protocol/lit-deposit-address` — deposit-address actions

At build time, `scripts/generate-actions.ts` runs each source package's
`bundle:actions` script, reads the emitted `dist/actions/<env>/<vm>.js` bundles
and `environments/<env>.json` config, and writes a single module at
`src/generated.ts`. That file is git-ignored and regenerated on every build —
no bundled artifacts are committed here.

```sh
yarn workspace @relay-protocol/lit-actions generate   # regenerate src/generated.ts
yarn workspace @relay-protocol/lit-actions build       # generate + tsc
```

To change which environments or VM types are exposed, edit the `KINDS` matrix
in `scripts/generate-actions.ts`.
