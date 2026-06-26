# Solver integration guide

This directory documents how solver-side code should integrate with the Lit Deposit Address actions.

The intended reader is an integrator working in the solver stack. The solver is responsible for building the Relay protocol order, triggering the Hub deposit-address manager, requesting the oracle trigger attestation, constructing the VM-native deposit transaction(s), invoking the correct Lit Action bundle, and submitting the signed transaction(s) to the origin chain or VM API.

**If you just want the recipe, jump to [Solver integration, step by step](#solver-integration-step-by-step).** The sections before it explain the trust model and the action API that the steps build on.

## Supported VM bundles

| VM type          | Document                                 | Purpose                                                                     |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `ethereum-vm`    | [ethereum-vm.md](./ethereum-vm.md)       | EVM native and ERC-20 deposits into an EVM depository.                      |
| `bitcoin-vm`     | [bitcoin-vm.md](./bitcoin-vm.md)         | Native BTC P2WPKH deposits with OP_RETURN metadata.                         |
| `solana-vm`      | [solana-vm.md](./solana-vm.md)           | Native SOL and SPL token deposits into the Relay Solana depository program. |
| `hyperliquid-vm` | [hyperliquid-vm.md](./hyperliquid-vm.md) | Hyperliquid `sendAsset` sweeps plus Relay nonce-mapping authorization.      |
| `ton-vm`         | [ton-vm.md](./ton-vm.md)                 | Native TON deposits swept to the depository with an order-id comment.       |

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

#### Derivation fields

`derivationFields` is the exact set of inputs that deterministically derive the deposit wallet's child path. The Lit Action computes the path as `keccak256(abi.encode((derivationFields)))` split into eight unhardened uint31 child segments (see [`../src/derivation/path.ts`](../src/derivation/path.ts)). Any change to any field produces a completely different deposit wallet, so the solver, the Hub trigger, the oracle attestation, and the Lit Action must all agree on these fields byte-for-byte.

The fields are encoded in this fixed order (the ABI tuple the hash is computed over):

| Field             | Type      | Meaning                                                                               |
| ----------------- | --------- | ------------------------------------------------------------------------------------- |
| `inputVmType`     | `string`  | VM the deposit is funded on; must match the action bundle and `trigger.input.vmType`. |
| `outputVmType`    | `string`  | VM the order settles on.                                                              |
| `outputChainId`   | `string`  | Destination chain id (decimal string).                                                |
| `outputCurrency`  | `bytes`   | Output currency, VM-address-encoded for the output VM.                                |
| `outputRecipient` | `bytes`   | Recipient of the output, VM-address-encoded for the output VM.                        |
| `solver`          | `address` | Solver EVM address; the EOA that must authorize `sign` via `requestSignature`.        |
| `pricingOracle`   | `address` | Pricing oracle EVM address bound to the quote.                                        |
| `depositor`       | `bytes`   | Depositor identity on the input VM, VM-address-encoded.                               |
| `refundRecipient` | `bytes`   | Refund recipient on the input VM, VM-address-encoded.                                 |
| `priceImpactBps`  | `uint256` | Price impact in basis points (decimal string in JSON, encoded as a `uint256`).        |

Non-EVM addresses (`outputCurrency`, `outputRecipient`, `depositor`, `refundRecipient`) are `bytes` carrying the protocol VM address encoding; `solver` and `pricingOracle` are always raw 20-byte EVM addresses. Use the settlement SDK address codecs to encode these fields so they hash identically across the solver, Hub, oracle, and action.

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

### Who can call the action

There are two independent authorization layers, and each `action` requires a different combination:

1. **Chipotle usage API key.** Every call to `/core/v1/lit_action` must present a usage API key authorized for the target action CID/group. Chipotle rejects the request before any Lit Action code runs if the key is missing or unauthorized. This gate applies to all actions (`account`, `wallet`, `sign`).
2. **Solver EOA signature (`sign` only).** For `action: "sign"`, the action additionally requires a valid `requestSignature`: an EIP-191 `personal_sign` by `order.solver` over the canonical JSON of the sign request (with `requestSignature` stripped). The action recovers the signer and rejects the call unless it matches `order.solver`.

In practice:

- `account` and `wallet` are read-only derivations. Anyone holding a valid usage API key can call them. They never sign a sweep, so they are safe to expose to diagnostic tooling.
- `sign` is the only action that produces a signed VM transaction, and it is gated by **both** the usage API key **and** the `order.solver` EOA key. Holding the API key alone is not enough to make the action sign anything: a caller must also be able to produce the solver's `requestSignature`. This means a leaked usage API key cannot be used to drain deposit wallets, and the solver still cannot make the action sign a payload that doesn't match an oracle-attested trigger and the signed order.

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
| `ton-vm`         | [`../scripts/examples/ton-vm.ts`](../scripts/examples/ton-vm.ts)                 |

Run them from `packages/lit-deposit-address` after exporting the required environment variables listed at the top of each file:

```sh
yarn tsx scripts/examples/ethereum-vm.ts
yarn tsx scripts/examples/bitcoin-vm.ts
yarn tsx scripts/examples/solana-vm.ts
yarn tsx scripts/examples/hyperliquid-vm.ts
yarn tsx scripts/examples/ton-vm.ts
```

These scripts are intentionally verbose and model the full solver flow: derive the deposit wallet, fund it, submit the Hub trigger, request the oracle attestation, call the Lit Action, and submit the signed sweep. They are examples for integrators, not production solver code.

## Solver integration, step by step

This is the end-to-end recipe a solver follows for one order. Each step names the concrete helper or script that implements it; the per-VM runnable example in [`../scripts/examples`](../scripts/examples) wires all of these together for a single VM and is the best reference to copy from.

**One-time setup (per VM bundle).** Call the `account` action once for the `inputVmType` you support and cache the returned `extendedPublicKey`. This is the public derivation root; every deposit address is derived from it off-TEE, so you never call the TEE on the quoting hot path.

```sh
yarn client account -- --env <env> --usage-api-key <key> --pkp-id <pkp> --vm-type <inputVmType>
```

### Step 1 — Construct the order (and the matching derivation fields)

From the quote, build two objects that must agree field-for-field:

- `derivationFields` — the inputs that deterministically derive the deposit address: `inputVmType`, the output side (`outputVmType` / `outputChainId` / `outputCurrency` / `outputRecipient`), `solver`, `pricingOracle`, `depositor`, `refundRecipient`, `priceImpactBps`. See the [derivation-fields table](#derivation-fields) for exact types and encodings.
- the Relay `Order` — built and hashed with the settlement SDK (`getOrderId(order, chainsConfig)`), then signed by the solver EOA (`orderSignature = solver.signMessage({ raw: orderId })`).

Construction rules that trip people up:

- **Address fields are VM-native in the order, but byte-encoded everywhere else.** The SDK's `getOrderId` / `normalizeOrder` run each address through `encodeAddress(addr, vmType)`, so the `Order` must carry VM-native strings (base58 for `solana-vm`, raw `0:<hex>` or friendly for `ton-vm`, `0x…` for EVM). The `trigger` payload, `derivationFields`, and the order you hand to the `sign` action instead carry the already-byte-encoded `0x…` form. The examples include a `normalizeOrderForAction` helper that does this conversion.
- **The deposit address depends only on `derivationFields`, not on `orderId`.** `orderId` binds the order to the trigger and is enforced by the deposit policy, but it is not part of the derivation path.
- Use the settlement SDK address codecs for all encoding; never hand-format addresses.

Reference: the order/`derivationFields` construction and `normalizeOrderForAction` at the top of [`../scripts/examples/<vm>.ts`](../scripts/examples).

### Step 2 — Derive the deposit address locally (no TEE)

Derive the address purely off-TEE from the cached account root and `derivationFields`:

```ts
import { deriveDepositWallet } from "../scripts/client/local-derivation.js";

const wallet = await deriveDepositWallet(account, derivationFields);
// wallet.address is where the user / solver sends the deposit
```

`deriveDepositWallet` (in [`../scripts/client/local-derivation.ts`](../scripts/client/local-derivation.ts)) computes `indexes = derivationFieldsToIndexes(derivationFields)` and runs public-only child derivation — equivalent to `deriveWalletFromExtendedPublicKey(vmType, account.extendedPublicKey, indexes)`. It needs no PKP and no network, so it is safe on the quoting hot path.

To reproduce this from the CLI (e.g. for debugging), point `derive` at a saved `account` response plus the derivation fields:

```sh
yarn client derive -- --account ./account-response.json --input ./derivation-fields.json
```

The `wallet` action returns the same address but runs inside the TEE and is comparatively expensive — use it only for occasional parity checks, never per quote. The `cross-derivation.test.ts` suite asserts the off-TEE and in-TEE addresses match for every VM.

### Step 3 — Fund the deposit address

The depositor sends the input currency to `wallet.address`. The solver typically also tops the address up with a small amount of native gas so the deposit wallet can pay for its own sweep transaction (see each VM doc for the exact funding shape).

### Step 4 — Submit the Hub trigger

Call `trigger(input, derivationFields, orderId, nonce, currencies, extraData)` on the Hub `DepositAddressManager` (see [DepositAddressManager trigger](#1-depositaddressmanager-trigger)). This records the on-chain binding the oracle later verifies.

Reference: `submitTrigger` in [`../scripts/examples/lib/common.ts`](../scripts/examples/lib/common.ts).

### Step 5 — Request the oracle attestation

`POST /attestations/deposit-address-triggers/v1` with `input`, `derivationFields`, `orderId`, `nonce`, `currencies`, `prices`, and `extraData`. The oracle verifies the Hub trigger and returns the `inputDepository`, `triggerHash`, and oracle `signatures` (see [Oracle trigger attestation](#2-oracle-trigger-attestation)).

Reference: `requestAttestation` in [`../scripts/examples/lib/common.ts`](../scripts/examples/lib/common.ts).

### Step 6 — Build the VM-native deposit transaction(s)

Once the deposit has landed in the deposit address, build the unsigned VM-native transaction(s) that sweep it into `attestation.inputDepository`, following the exact shape and policy in the VM's document ([ethereum-vm](./ethereum-vm.md), [bitcoin-vm](./bitcoin-vm.md), [solana-vm](./solana-vm.md), [hyperliquid-vm](./hyperliquid-vm.md), [ton-vm](./ton-vm.md)). The action re-derives these constraints and rejects anything that doesn't match the attested trigger.

### Step 7 — Authorize and sign inside the TEE

The `sign` action requires a solver `requestSignature` in addition to the usage API key. Build the sign request, sign its canonical hash with the solver EOA, then call the matching VM bundle:

```ts
import { addSolverRequestSignature } from "../scripts/examples/solver-request.js";

const signRequest = await addSolverRequestSignature(
  { pkpId, action: "sign", trigger, attestation, order, orderSignature, transactions },
  solver, // the order.solver EOA
);
const { signedTransactions } = await executeLitAction(client, signRequest);
```

The action verifies the bundle/trigger match, the oracle attestation, the order binding, the `requestSignature`, and the VM-specific transaction policy before deriving the key and signing (see [Lit Action verification](#3-lit-action-verification)).

### Step 8 — Broadcast (and resolve the deposit transaction)

Submit the signed transaction(s) through the solver's normal transaction pipeline. For chains where the sweep is a raw transaction (EVM, Bitcoin, Solana) the broadcast hash is the deposit transaction. For TON the response is an external-message BOC: broadcast it with `TonClient.sendFile`, then resolve the on-chain deposit by locating the depository transaction whose inbound message comes from the deposit wallet and whose comment carries the order id — its tx hash + logical time (`lt`) are what the oracle's deposit attestation needs. The [`ton-vm.ts`](../scripts/examples/ton-vm.ts) example shows this resolution step.

## Encoding conventions

Addresses in trigger fields, derivation fields, orders, and VM policies are encoded according to the Relay protocol's standard VM address encoding rules. Solver integrations should use the settlement SDK/protocol address codecs rather than ad-hoc string comparisons.

- `ethereum-vm`: raw 20-byte EVM addresses, represented as `0x` hex.
- `hyperliquid-vm`: raw hex identifiers using the Hyperliquid protocol encoding; account addresses are EVM-style 20-byte values, while token ids may be shorter (for example 16 bytes).
- `solana-vm`: raw 32-byte public keys. In protocol fields these are hex-encoded; VM-native transaction messages still use normal Solana account keys.
- `bitcoin-vm`: settlement SDK-compatible Bitcoin address encoding. Derivation-field addresses should be normalized through the VM address codec.
- `ton-vm`: the 32-byte basechain (workchain 0) StateInit account hash. Protocol fields are hex-encoded; VM-native addresses accept the raw `0:<hex>` form and the user-facing friendly base64 forms.
- Amounts in triggers are integer base units as decimal strings.
- `orderId` and trigger ids are `0x`-prefixed 32-byte hex strings.

## Security model

The action is not a general-purpose signer. `sign` rejects payloads that do not match the current attested trigger and order. Solver integrations should still perform their own preflight checks and log the exact payload sent to the action, but they should rely on action-side policy as the final TEE signing gate.
