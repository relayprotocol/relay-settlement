# Solana VM solver integration

Solana compiled messages for Relay depository deposits.

Runnable example: [`../scripts/examples/solana-vm.ts`](../scripts/examples/solana-vm.ts). See [`README.md`](./README.md) for the action API, request-signature requirement, and end-to-end design.

## Wallet format

- Derivation path: `m/44'/501'/0'/0/<indexes...>`
- Address: base58 Ed25519 public key
- Public key: same base58 Ed25519 public key

## Transactions

`transactions[]` must contain exactly one compiled message:

```ts
{
  message: string;
} // base64-encoded compiled Solana message bytes
```

### Signer layout

The compiled message must require 1 or 2 signatures, and the deposit wallet must occupy the **last** required-signer slot:

- 1 signer: deposit wallet is signer slot `0` and the fee payer.
- 2 signers: an external fee payer is slot `0`, the deposit wallet is slot `1`. The solver signs slot `0` after the action returns.

Messages requiring more than two signatures are rejected.

### Native SOL deposit

When `trigger.input.currency` is Solana's native/gas currency, the single instruction must call `deposit_native(amount, id)` on `attestation.inputDepository`:

- 5 Anchor accounts: `relay_depository, sender, depositor, vault, system_program`.
- `sender` is the deposit wallet signer slot.
- `depositor` equals `trigger.derivationFields.depositor`.
- Borsh `amount == trigger.input.amount`, `id == trigger.orderId`.

### SPL token deposit

When `trigger.input.currency` is an SPL token mint, the single instruction must call `deposit_token(amount, id)`:

- 10 Anchor accounts: `relay_depository, sender, depositor, vault, mint, sender_token_account, vault_token_account, token_program, associated_token_program, system_program`.
- `mint` equals `trigger.input.currency`.
- Other checks as for `deposit_native`.

Address-table-lookup accounts are not supported for accounts referenced by the deposit instruction.

## Sign response

Per signed transaction:

```ts
{
  signature: string,      // 64-byte Ed25519 signature, 0x-prefixed
  rawTransaction: string, // base64: shortvec(N) || signatures || message
}
```

Non-wallet signer slots are zero-filled.

## Submission notes

- With a separate fee payer, sign slot `0` of the returned base64 transaction before submission.
- The solver is responsible for recent blockhash freshness and for creating any associated token accounts outside the single-instruction deposit message.
