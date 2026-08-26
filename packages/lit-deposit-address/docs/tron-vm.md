# Tron Deposit Address integration

The `tron-vm` Lit Action derives case-sensitive Tron Base58Check wallets and signs native TRX or TRC20 deposit sweeps. It is not a general Tron signer: the action decodes the exact `protocol.Transaction` protobuf bytes and rejects any batch that does not match the attested deposit trigger.

## Derivation and address encoding

- Curve: secp256k1.
- Account path: `m/44'/195'/0'/0`.
- Deposit path: the account path followed by the eight unhardened indexes derived from `derivationFields`.
- Derivation fields: the v2 payload includes `salt`; changing it changes the derived indexes and wallet.
- Address: `Base58Check(0x41 || keccak256(uncompressedPublicKey[1:])[12:])`.
- Protocol encoding: the 21-byte payload (`0x41` plus the 20-byte account body), represented as `0x` hex in trigger and attestation fields.

Do not lowercase a Tron address. Use `encodeAddress(address, "tron-vm")` and `decodeAddress(bytes, "tron-vm")` from the settlement SDK at protocol boundaries.

TVM Solidity ABI `address` arguments are different from protocol address fields: their 32-byte ABI word contains only the 20-byte account body, with the leading Tron `0x41` byte removed and the value left-padded with zeros. Use TronWeb's ABI encoder or apply this conversion explicitly when constructing calldata.

## Transaction input and output

Each signing input carries the exact unsigned Tron `raw_data` protobuf, not a parallel JSON description:

```ts
interface TronVmTransaction {
  purpose: "native-deposit" | "trc20-pre-approval" | "trc20-approval" | "trc20-deposit";
  rawData: string;
}
```

`rawData` is `0x`-prefixed canonical `protocol.Transaction.raw` protobuf hex. The action returns:

```ts
interface TronVmSignedTransaction {
  rawTransaction: string;
  transactionHash: string;
}
```

`rawTransaction` is the signed protobuf ready for `wallet/broadcasthex`. `transactionHash` is lowercase SHA-256 of the exact encoded `raw_data`, without an `0x` prefix.

## Accepted deposit batches

Native TRX requires exactly one `native-deposit` transaction:

- one `TriggerSmartContract` owned by the derived deposit wallet;
- `contract_address` equals `attestation.inputDepository`;
- `call_value` equals `trigger.input.amount`;
- calldata is exactly `depositNative(depositor, orderId)`.

TRC20 accepts one of these ordered batches:

1. `trc20-approval`, `trc20-deposit`;
2. `trc20-pre-approval`, `trc20-approval`, `trc20-deposit` for tokens that require allowance reset.

The pre-approval must call `approve(inputDepository, 0)`. The approval must call `approve(inputDepository, input.amount)`. The deposit must call `depositErc20(depositor, input.currency, input.amount, orderId)` on the attested depository. Every smart-contract transaction must have zero `call_value` in the TRC20 flow.

## Freshness and protobuf constraints

The action requires a two-byte `ref_block_bytes`, an eight-byte `ref_block_hash`, an unexpired transaction, and an expiration no more than one hour after its timestamp. The solver must obtain the reference block from its configured fullnode immediately before building the transaction. As with Solana's recent blockhash, the action validates the reference's encoded shape but cannot prove that the referenced block exists without adding an external RPC trust dependency. The solver's request signature covers the exact protobuf, including both TAPOS fields, and the DA service is responsible for freshness before requesting that signature.

Multiple contracts, unknown protobuf fields, unsupported contract types, mismatched type URLs, and non-canonical deposit shapes are rejected before signing. Signatures cannot be supplied at the input boundary because `rawData` does not contain the outer transaction envelope.

The signer computes `txID = SHA256(raw_data)`, produces a canonical low-S secp256k1 signature as `r || s || recovery`, and appends that signature to a new `protocol.Transaction` envelope while preserving the exact `raw_data` bytes.

## Broadcasting

TronWeb can broadcast the returned bytes directly:

```ts
const result = await tronWeb.trx.sendHexTransaction(signed.rawTransaction.replace(/^0x/, ""));

if (!result.result || result.txid.toLowerCase() !== signed.transactionHash) {
  throw new Error("Tron broadcast hash mismatch");
}
```

See [`../scripts/examples/tron-vm.ts`](../scripts/examples/tron-vm.ts) for building native and TRC20 protobuf batches, invoking Lit, broadcasting each signed transaction, and checking the returned hashes.
