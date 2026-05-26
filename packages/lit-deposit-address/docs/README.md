# Solver integration guide

This directory documents how solver-side code should integrate with the Lit Deposit Address actions.

The intended reader is an integrator working in the solver stack. The solver is responsible for building the Relay protocol order, triggering the Hub deposit-address manager, requesting the oracle trigger attestation, constructing the VM-native deposit transaction(s), invoking the correct Lit Action bundle, and submitting the signed transaction(s) to the origin chain or VM API.

## Supported VM bundles

| VM type          | Document                                 | Purpose                                                                     |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `ethereum-vm`    | [ethereum-vm.md](./ethereum-vm.md)       | EVM native and ERC-20 deposits into an EVM depository.                      |
| `bitcoin-vm`     | [bitcoin-vm.md](./bitcoin-vm.md)         | Native BTC P2WPKH deposits with OP_RETURN metadata.                         |
| `solana-vm`      | [solana-vm.md](./solana-vm.md)           | Native SOL and SPL token deposits into the Relay Solana depository program. |
| `hyperliquid-vm` | [hyperliquid-vm.md](./hyperliquid-vm.md) | Hyperliquid `sendAsset` sweeps plus Relay nonce-mapping authorization.      |

## End-to-end design

The deposit-address flow is split across three trust boundaries:

1. **Hub DepositAddressManager** records an on-chain trigger for a specific order and deterministic deposit address.
2. **Relay oracle** verifies the Hub trigger and signs an attestation over the trigger hash.
3. **Lit Action** verifies the oracle attestation and order data inside the TEE before signing any VM-native sweep transaction.

This means the solver can prepare and submit transactions, but it cannot make the Lit Action sign arbitrary payloads. The action only signs when the transaction batch is consistent with an oracle-attested Hub trigger and the signed solver order.

### 1. DepositAddressManager trigger

After constructing the Relay order, the solver submits `trigger(...)` to the Hub `DepositAddressManager`.

The trigger binds:

- `input`: source VM, source chain id, input currency, and input amount.
- `derivationFields`: all fields that deterministically derive the deposit wallet path, including output details, solver, pricing oracle, depositor, refund recipient, and price impact.
- `orderId`: the Relay order id being funded.
- `nonce`: Hub trigger nonce.
- `currencies`, `prices`, and `extraData`: pricing context used by the trigger hash.

The deposit wallet address itself is not chosen by the solver. It is derived from the PKP root and `derivationFields`; the solver should compute it locally from the VM account public root before calling `trigger(...)`.

### 2. Oracle trigger attestation

Once the trigger transaction is mined, the solver requests a deposit-address trigger attestation from the Relay oracle.

The oracle verifies that the Hub `DepositAddressManager` has recorded the expected trigger data, then returns an attestation containing:

- Hub chain id.
- `depositAddressManager` address.
- `inputDepository`: the VM-specific depository that should receive the sweep.
- `triggerHash`.
- oracle signatures over the trigger hash.

For solver integrations, this attestation is the bridge between the Hub's on-chain trigger and the off-chain Lit Action signing request.

### 3. Lit Action verification

When the solver calls `action: "sign"`, the Lit Action performs all final checks inside the TEE before deriving the deposit wallet private key and signing.

The action verifies:

1. The VM bundle matches `trigger.input.vmType` and `trigger.derivationFields.inputVmType`.
2. The oracle attestation is signed by the configured oracle set and satisfies the configured threshold.
3. The attestation references the configured Hub `DepositAddressManager` and Hub chain id for the bundled environment.
4. The attested trigger hash matches the supplied `trigger` fields.
5. The supplied Relay order and `orderSignature` match the trigger/order binding.
6. The VM-native transaction batch satisfies the VM-specific policy documented in this directory.

Only after these checks pass does the action derive the deposit wallet key and sign the supplied transaction(s). This is the final authorization boundary: even if the solver is compromised, it cannot use the action to sign a sweep that does not correspond to a valid attested trigger and order.

## Common action API

Each VM is bundled as a separate Lit Action file. This source package can produce local bundles under:

```text
dist/actions/<env>/<vmType>.js
```

For production solver integrations, use the canonical bundled action code published by the sibling [`../lit-actions`](../../lit-actions) package. That package is the source of truth for the action source/CIDs callers should execute against Chipotle.

The solver calls Chipotle's `/core/v1/lit_action` endpoint with a usage API key authorized for the target action CID/group:

```json
{
  "js_params": {
    "pkpId": "0x...",
    "action": "wallet | sign | account",
    "...": "action-specific fields"
  },
  "code": "<bundle source>"
}
```

The helper in `scripts/client/index.ts` wraps this call as `executeLitAction(...)` and sends the key in the `X-Api-Key` header. Without a valid usage API key, Chipotle rejects the action execution before the Lit Action code runs.

### `action: "account"`

Returns the account-level derivation root for a VM bundle.

Required params:

```json
{
  "pkpId": "0x...",
  "action": "account",
  "vmType": "ethereum-vm"
}
```

Response shape:

```ts
{
  vmType: VmType;
  accountPath: string;
  publicKey: string;
  extendedPublicKey: string;
}
```

### `action: "wallet"`

Returns the deterministic deposit wallet derived from the trigger derivation fields.

Required params:

```ts
{
  pkpId: string;
  action: "wallet";
  derivationFields: DepositAddressTriggerDerivationFields;
}
```

The action derives the wallet path from `derivationFields`; solver-side code should derive locally from `account.extendedPublicKey` as a parity check before using the address.

Response shape:

```ts
{
  vmType: VmType
  indexes: number[]
  path: string
  address: string
  publicKey: string
}
```

### `action: "sign"`

Signs VM-native transaction payloads for the derived deposit wallet.

Required params:

```ts
{
  pkpId: string
  action: "sign"
  trigger: DepositAddressTrigger
  attestation: DepositAddressTriggerAttestation
  order: Order
  orderSignature: string
  requestSignature: string
  transactions: VmTransactionMap[vmType][]
}
```

Before signing, the action verifies:

1. The bundle VM matches `trigger.input.vmType` and `trigger.derivationFields.inputVmType`.
2. `requestSignature` is an EIP-191 signature by `order.solver` over the canonical JSON sign request, excluding `requestSignature` itself. This protects the PKP if the usage API key is leaked.
3. The oracle attestation is valid for the trigger.
4. The signed order matches the trigger/order fields.
5. The VM-native transaction(s) match the VM-specific deposit policy.

Response shape:

```ts
{
  wallet: WalletInfo
  triggerHash: string
  signedTransactions: VmSignedTransactionMap[vmType][]
}
```

## Runnable examples

The repository includes source-controlled end-to-end example scripts under [`../scripts/examples`](../scripts/examples):

| VM type          | Example                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `ethereum-vm`    | [`../scripts/examples/ethereum-vm.ts`](../scripts/examples/ethereum-vm.ts)       |
| `bitcoin-vm`     | [`../scripts/examples/bitcoin-vm.ts`](../scripts/examples/bitcoin-vm.ts)         |
| `solana-vm`      | [`../scripts/examples/solana-vm.ts`](../scripts/examples/solana-vm.ts)           |
| `hyperliquid-vm` | [`../scripts/examples/hyperliquid-vm.ts`](../scripts/examples/hyperliquid-vm.ts) |

Run them from `packages/lit-deposit-address` after exporting the required environment variables listed at the top of each file:

```sh
yarn tsx scripts/examples/ethereum-vm.ts
yarn tsx scripts/examples/bitcoin-vm.ts
yarn tsx scripts/examples/solana-vm.ts
yarn tsx scripts/examples/hyperliquid-vm.ts
```

These scripts are intentionally verbose and model the full solver flow: derive the deposit wallet, fund it, submit the Hub trigger, request the oracle attestation, call the Lit Action, and submit the signed sweep. They are examples for integrators, not production solver code.

## Common solver flow

1. Build `input` and `derivationFields` for the quote/order.
2. Derive the deposit wallet locally from the VM account public root and the same `derivationFields`.
3. Submit `trigger(...)` to the Hub deposit-address manager.
4. Request `/attestations/deposit-address-triggers/v1` from the Relay oracle.
5. Construct VM-native transaction payload(s) that satisfy the VM policy.
6. Add `requestSignature` by signing the canonical sign request hash with `order.solver`.
7. Call `sign` on the matching VM bundle.
8. Submit the signed transaction(s) through the solver's normal transaction pipeline.

## Local wallet derivation

Solvers should not call the Lit Action's `wallet` action on every quote or order. That call executes inside Lit/Chipotle and is comparatively expensive. Instead:

1. Call `account` once per VM bundle with a valid usage API key and cache the returned `extendedPublicKey`.
2. For each order, compute `indexes = derivationFieldsToIndexes(derivationFields)`.
3. Derive the deposit wallet locally with `deriveWalletFromExtendedPublicKey(vmType, extendedPublicKey, indexes)`.
4. Use the Lit Action only for `sign`, when funds are ready to sweep and an oracle-attested trigger/order exists.

The `wallet` action is still useful for diagnostics, parity checks, and debugging, but it should not be in the hot path for solver quoting or request construction.

## Encoding conventions

Addresses in trigger fields, derivation fields, orders, and VM policies are encoded according to the Relay protocol's standard VM address encoding rules. Solver integrations should use the settlement SDK/protocol address codecs rather than ad-hoc string comparisons.

- `ethereum-vm`: raw 20-byte EVM addresses, represented as `0x` hex.
- `hyperliquid-vm`: raw hex identifiers using the Hyperliquid protocol encoding; account addresses are EVM-style 20-byte values, while token ids may be shorter (for example 16 bytes).
- `solana-vm`: raw 32-byte public keys. In protocol fields these are hex-encoded; VM-native transaction messages still use normal Solana account keys.
- `bitcoin-vm`: settlement SDK-compatible Bitcoin address encoding. Derivation-field addresses should be normalized through the VM address codec.
- Amounts in triggers are integer base units as decimal strings.
- `orderId` and trigger ids are `0x`-prefixed 32-byte hex strings.

## Security model

The action is not a general-purpose signer. `sign` rejects payloads that do not match the current attested trigger and order. Solver integrations should still perform their own preflight checks and log the exact payload sent to the action, but they should rely on action-side policy as the final TEE signing gate.
