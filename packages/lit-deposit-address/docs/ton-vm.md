# TON VM solver integration

Native-TON deposits swept from a per-order deposit wallet into the Relay depository.

Runnable example: [`../scripts/examples/ton-vm.ts`](../scripts/examples/ton-vm.ts). See [`README.md`](./README.md) for the action API, request-signature requirement, and end-to-end design.

## Deposit model

TON has no per-order on-chain deposit instruction. Instead, the oracle detects a deposit as a **native-TON internal message to the depository** carrying the order id in a TON text comment (the same metadata model as bitcoin-vm's OP_RETURN). Concretely the oracle credits a deposit when it sees an internal message that:

- is addressed to the depository on workchain 0, non-bounceable, and not reverted;
- has a text-comment body (opcode `0`);
- whose comment starts with the order id (`0x<64hex>`) and optionally carries `|depositor=<ton-addr>|`;
- the depositor is taken from the `|depositor=|` metadata if present, otherwise from the inbound sender.

So the deposit-address flow on TON is: derive a per-order deposit wallet, the user funds it, and the Lit Action signs a single transfer that forwards the funds to the depository with the order id (and real depositor) in the comment.

## Wallet format

- Wallet contract: **Wallet V5R1** (older v3/v4 wallets are deprecated). Basechain (workchain 0), subwallet 0, mainnet network id.
- Derivation path: `m/44'/607'/0'/0/<indexes...>` using the publicly-derivable CIP-3 / BIP32-Ed25519 scheme (same scheme as `solana-vm`), so deposit wallets derive from the account `extendedPublicKey` alone.
- Address: the StateInit account hash, raw form `0:<hex>`.
- Public key: the raw 32-byte Ed25519 key as `0x<hex>`.

> Like `solana-vm`, the Ed25519 derivation here is non-standard for typical TON wallets (which use hardened-only derivation from a mnemonic), but it produces a valid Wallet V5R1 deployment and a standard Ed25519 keypair.

## Transactions

`transactions[]` must contain exactly one transfer describing the sweep to the depository:

```ts
{
  to: string,         // depository address (raw `0:<hex>` or friendly); must equal attestation.inputDepository
  amount: string,     // nanoton amount, decimal string; must equal trigger.input.amount
  comment: string,    // `${trigger.orderId}|depositor=${depositor}|`
  bounce: boolean,    // must be false
  seqno: number,      // wallet seqno; 0 includes the StateInit so the first spend deploys the wallet
  validUntil: number, // unix seconds; ignored when seqno === 0 (uses the max)
  sendMode: number    // TON send mode; must not carry the remaining balance (so `amount` is exact)
}
```

The action builds the canonical Wallet V5R1 external message from these fields, signs the signed-request cell hash with the deposit wallet's Ed25519 key, and returns a ready-to-broadcast bag-of-cells.

### Policy

`verifyTransactions` enforces, for the single transfer:

- native TON only (`trigger.input.currency` is the 32-zero-byte sentinel);
- `to` resolves to `attestation.inputDepository` (workchain 0);
- `bounce === false` (a bounce would auto-refund and reverse the credit);
- `amount === trigger.input.amount`, with a send mode that delivers exactly that value (no `CARRY_ALL_REMAINING_BALANCE`/`_INCOMING` bits);
- the comment starts with `trigger.orderId` and carries `|depositor=<addr>|` resolving to `trigger.derivationFields.depositor`.

## Sign response

```ts
{
  signature: string,       // 64-byte Ed25519 signature over the signed-request cell hash, 0x-prefixed
  signingHash: string,     // the signed-request cell hash that was signed, 0x-prefixed
  externalMessage: string  // base64 bag-of-cells of the external-in message, ready to broadcast
}
```

## Submission notes

- Broadcast `externalMessage` directly (e.g. `TonClient.sendFile(Buffer.from(externalMessage, "base64"))`).
- Fund the deposit wallet with `amount` plus a small gas buffer (the wallet pays the message-forward fee out of its remaining balance under `sendMode = 3`).
- Use `seqno: 0` for the first spend so the external message carries the StateInit and deploys the wallet; use the wallet's current seqno (and a real `validUntil`) for subsequent spends.
- The deposit wallet is not the depositor of record: the `|depositor=|` comment metadata is what credits `trigger.derivationFields.depositor`, so it must always be present and correct.
