# @relay-protocol/lit-actions

Helpers for loading the Lit Actions used by Relay.

## API

This package currently exposes a single allocator-focused helper:

```ts
getAllocatorAction(environment, version, vmType)
```

It returns:

- the bundled JavaScript source code for the corresponding action
- the allocator environment config bundled into this package

## Types

`vmType` uses `VmType` from `@relay-protocol/settlement-sdk`.

Allocator-specific types exported by this package:

- `AllocatorActionEnvironment`
- `AllocatorActionVersion`
- `AllocatorActionConfig`
- `AllocatorAction`

## Supported values

Currently embedded allocator actions:

- `environment`: `dev`
- `version`: `v1`
- `vmType`: `ethereum-vm`, `solana-vm`

If a version, environment, or VM type is missing, `getAllocatorAction` throws.

## Example

```ts
import { getAllocatorAction } from "@relay-protocol/lit-actions"
import { VmType } from "@relay-protocol/settlement-sdk"

const vmType: VmType = "ethereum-vm"
const action = getAllocatorAction("dev", "v1", vmType)

console.log(action.code)
console.log(action.config)
```

## Package structure

Allocator actions are organized by:

```txt
src/allocator/<version>/<environment>/<vm-type>.ts
```

Current embedded files:

```txt
src/allocator/v1/dev/config.ts
src/allocator/v1/dev/ethereum-vm.ts
src/allocator/v1/dev/solana-vm.ts
```

Each environment exports:

- `config` — allocator environment config
- `code` — a map of VM type to bundled JavaScript source

## Notes

- allocator action code and config are bundled into this package
