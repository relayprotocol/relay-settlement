# Bitcoin VM solver integration

Native BTC deposit transactions for P2WPKH deposit addresses.

Runnable example: [`../scripts/examples/bitcoin-vm.ts`](../scripts/examples/bitcoin-vm.ts).
See the [package README](../README.md#action-api) for the action API and the
[solver guide](./README.md) for the end-to-end flow.

## Wallet format

- Derivation path: `m/84'/0'/0'/0/<indexes...>`
- Address: native segwit P2WPKH `bc1...`
- Public key: compressed secp256k1 public key hex

## Transactions

Only native BTC deposits are supported. `transactions[]` must contain exactly one item:

```ts
{
  unsignedTransaction: string // hex, no witness data
  inputValues: string[]       // previous-output values in satoshis, one per input
  sighashes: string[]         // BIP143 SIGHASH_ALL digests, 0x-prefixed 32-byte hex, one per input
}
```

The action recomputes every sighash from `unsignedTransaction` + `inputValues` + the derived deposit wallet's P2WPKH script and rejects any mismatch.

### Policy

- Sends exactly `trigger.input.amount` satoshis to the scripts encoded by `attestation.inputDepository`.
- Any non-depository, non-`OP_RETURN` output must pay `trigger.derivationFields.refundRecipient`.
- Contains an `OP_RETURN` output whose UTF-8 payload starts with `trigger.orderId` and includes `|depositor=<address>|`.
- The depositor encoded from the `OP_RETURN` metadata matches `trigger.derivationFields.depositor`.
- `inputValues.length == sighashes.length == input count`.

## Sign response

Per signed transaction:

```ts
{ signatures: string[] } // compact 64-byte ECDSA signatures, 0x-prefixed, one per input
```

The solver assembles the final witness stack using each compact signature plus the deposit wallet public key.

## Submission notes

- The solver owns UTXO selection, fee calculation, change output construction, and final transaction assembly.
- The action does not return a fully serialized signed Bitcoin transaction.
- Changing outputs after signing invalidates the sighashes.
