# Ethereum VM solver integration

EVM transactions for deposit-address sweeps into an EVM Relay depository.

Runnable example: [`../scripts/examples/ethereum-vm.ts`](../scripts/examples/ethereum-vm.ts). See [`README.md`](./README.md) for the action API, request-signature requirement, and end-to-end design.

## Wallet format

- Derivation path: `m/44'/60'/0'/0/<indexes...>`
- Address: EVM `0x` address derived from secp256k1 public key (`keccak256(pubkey[1:])[12:]`)
- Public key: compressed secp256k1 public key hex

## Transactions

The `transactions[]` payload depends on `trigger.input.currency`.

### Native deposit

When `trigger.input.currency` is the chain's native/gas currency, pass exactly one transaction:

```ts
{
  unsignedTransaction: string;
} // serialized unsigned EVM tx, 0x-prefixed
```

The unsigned transaction must:

- `to == attestation.inputDepository`
- `value == trigger.input.amount`
- call `depositNative(address depositor, bytes32 orderId)`
- pass `depositor == trigger.derivationFields.depositor`
- pass `orderId == trigger.orderId`

### ERC-20 deposit

When `trigger.input.currency` is an ERC-20 token, pass two transactions in this order:

1. `approve(spender = attestation.inputDepository, value = trigger.input.amount)` on the token contract.
2. `depositErc20(depositor, token, amount, orderId)` on the depository, where every arg matches the trigger.

Both transactions must carry `value == 0` and target the right `to` (token for `approve`, depository for `depositErc20`).

## Sign response

Per signed transaction:

```ts
{ rawTransaction: string, transactionHash: string }
```

For ERC-20 the response array has two entries, in the same order as the request.

## Submission notes

- Submit signed transactions in order.
- For ERC-20, wait for or otherwise account for approval inclusion before submitting `depositErc20`.
- The solver is responsible for selecting nonce, gas, fees, EIP-155 chain id, and transaction type before requesting the signature. The action signs the supplied unsigned transaction hash without mutating any of those fields.
