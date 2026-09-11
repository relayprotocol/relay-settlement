# Deposit-address solver integration

This guide covers one deposit from address derivation through broadcast. The
three action operations and their security checks are summarized in the
[package README](../README.md#action-api).

## Prerequisites

For each environment and input VM, provision:

- the current action code from `@relay-protocol/lit-actions`;
- the environment's PKP id and Lit usage API key;
- the public account root returned by `action: "account"`;
- the Relay oracle and Hub configuration for the same environment; and
- the solver EOA used as `order.solver`.

Fetch and cache the public root once:

```sh
yarn workspace @relay-protocol/lit-deposit-address client account -- \
  --env <env> \
  --usage-api-key <usage-api-key> \
  --pkp-id <pkp-address> \
  --vm-type <input-vm-type>
```

Do not mix action code, PKPs, public roots, triggers, or attestations from
different environments.

## Supported input VMs

| VM                                      | Transaction policy             |
| --------------------------------------- | ------------------------------ |
| [`ethereum-vm`](./ethereum-vm.md)       | Native and ERC-20 EVM deposits |
| [`bitcoin-vm`](./bitcoin-vm.md)         | Native BTC P2WPKH deposits     |
| [`solana-vm`](./solana-vm.md)           | Native SOL and SPL deposits    |
| [`hyperliquid-vm`](./hyperliquid-vm.md) | `sendAsset` deposits           |
| [`ton-vm`](./ton-vm.md)                 | Native TON deposits            |
| [`tron-vm`](./tron-vm.md)               | Native TRX and TRC20 deposits  |

## Derivation fields

The deposit wallet depends on the ABI encoding of every field below, in this
order:

| Field             | Encoding                                      |
| ----------------- | --------------------------------------------- |
| `inputVmType`     | Input VM string; must match the action bundle |
| `outputVmType`    | Output VM string                              |
| `outputChainId`   | Decimal string                                |
| `outputCurrency`  | Protocol VM-address bytes                     |
| `outputRecipient` | Protocol VM-address bytes                     |
| `solver`          | 20-byte EVM address                           |
| `pricingOracle`   | 20-byte EVM address                           |
| `depositor`       | Protocol VM-address bytes                     |
| `refundRecipient` | Protocol VM-address bytes                     |
| `priceImpactBps`  | Decimal `uint256` string                      |
| `salt`            | Fresh random `uint256` decimal string         |

The action hashes this tuple and splits the result into eight unhardened child
indexes. Any changed byte produces a different wallet. Use the settlement SDK
address codecs; do not hand-format non-EVM addresses.

## One-deposit recipe

### 1. Build and sign the order

Build the Relay `Order` with VM-native address strings, compute its id with the
settlement SDK, and sign the id with the solver EOA. Build `derivationFields`
from the same values, using protocol byte-encoded addresses.

Before sending the order to the Lit Action, normalize its VM-native addresses
to the same protocol byte encoding. The runnable examples use
`normalizeOrderForAction` for this conversion.

The deposit address depends on `derivationFields`, not `orderId`. `orderId` is
still checked when the sweep is signed.

### 2. Derive the deposit wallet locally

Use the cached public account root; this does not contact Lit or expose private
key material:

```ts
import { deriveDepositWallet } from "../scripts/client/local-derivation.js";

const wallet = await deriveDepositWallet(account, derivationFields);
```

For a CLI parity check:

```sh
yarn workspace @relay-protocol/lit-deposit-address client derive -- \
  --account account.json \
  --input derivation-fields.json
```

### 3. Fund the wallet

Send the exact input amount to `wallet.address`. Add native gas separately when
the input chain requires the deposit wallet to pay its sweep fee. The per-VM
guide states the accepted transaction shape.

### 4. Record the Hub trigger

Call `DepositAddressManager.trigger(...)` with the input, derivation fields,
order id, nonce, currencies, and extra data used for this deposit. Wait for the
Hub transaction to be confirmed.

### 5. Request the oracle attestation

Call:

```text
POST /attestations/deposit-address-triggers/v1
```

Send the same trigger fields. The response supplies `inputDepository`,
`triggerHash`, and oracle signatures. Reject a response for a different Hub
chain, manager, or trigger hash.

### 6. Build the unsigned sweep

Build `transactions[]` exactly as required by the selected
[VM policy](#supported-input-vms). The action rejects changed recipients,
amounts, order ids, currencies, or unsupported instructions.

### 7. Authorize and execute `sign`

Construct the complete sign request and add the solver's EIP-191
`requestSignature`:

```ts
const request = await addSolverRequestSignature(
  {
    pkpId,
    action: "sign",
    trigger,
    attestation,
    order,
    orderSignature,
    transactions,
  },
  solver,
);

const result = await executeLitAction(client, request);
```

Use the action bundle matching `trigger.input.vmType`. Confirm the returned
wallet and `triggerHash` before using `signedTransactions`.

### 8. Broadcast

Submit the signed transactions in their returned order. Preserve their exact
bytes after signing. Wait for the input-chain success condition before asking
the Relay oracle to attest the deposit.

TON returns an external-message BOC rather than the depository transaction
hash; resolve the resulting depository transaction as described in the
[TON guide](./ton-vm.md#submission-notes).

## Runnable examples

The examples perform the complete flow and list their required environment
variables at the top of each file:

```sh
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/ethereum-vm.ts
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/bitcoin-vm.ts
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/solana-vm.ts
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/hyperliquid-vm.ts
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/ton-vm.ts
yarn workspace @relay-protocol/lit-deposit-address tsx scripts/examples/tron-vm.ts
```

These scripts are integration references, not production solver code.
