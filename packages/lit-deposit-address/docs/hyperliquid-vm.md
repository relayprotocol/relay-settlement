# Hyperliquid VM solver integration

Hyperliquid `sendAsset` actions plus the Relay nonce-mapping authorization needed to bind a Hyperliquid transfer nonce to a Relay order.

Hyperliquid deposits are not EVM transactions: the solver submits signed actions to Hyperliquid's REST `/exchange` endpoint and submits the signed nonce mapping to the solver/oracle authorize flow before broadcasting the transfer.

Runnable example: [`../scripts/examples/hyperliquid-vm.ts`](../scripts/examples/hyperliquid-vm.ts). See [`README.md`](./README.md) for the action API, request-signature requirement, and end-to-end design.

## Wallet format

- Derivation path: `m/44'/60'/0'/0/<indexes...>`
- Address: EVM-style `0x` address derived from secp256k1 public key
- Public key: compressed secp256k1 public key hex

## Transactions

`transactions[]` must contain exactly one entry pairing a nonce mapping with a `sendAsset` action:

```ts
{
  nonceMapping: {
    walletChainId: string; // protocol chain id, e.g. "hyperliquid"
    wallet: string; // derived deposit wallet
    depositor: string; // matches trigger.derivationFields.depositor
    id: string; // = trigger.orderId
    nonce: string; // = sendAsset.nonce, decimal
  }
  sendAsset: {
    type: "sendAsset";
    signatureChainId: string; // Hyperliquid EIP-712 domain chainId, e.g. "0xa4b1"
    hyperliquidChain: "Mainnet";
    destination: string; // = attestation.inputDepository
    sourceDex: "" | "spot"; // "" for native USDC perp, "spot" for spot tokens
    destinationDex: "" | "spot";
    token: string; // SYMBOL:0x<16-byte-token>; native deposits must use USDC:<SPOT_USDC>
    amount: string; // decimal whole-token units
    fromSubAccount: string; // must be empty
    nonce: number; // == nonceMapping.nonce
  }
}
```

### Policy highlights

- `nonceMapping` and `sendAsset` agree on `nonce`.
- `nonceMapping.walletChainId == trigger.input.chainId`, `nonceMapping.id == trigger.orderId`, `nonceMapping.depositor` encodes to `trigger.derivationFields.depositor`.
- `sendAsset.destination` encodes to `attestation.inputDepository`.
- Native deposits require `sourceDex == destinationDex == ""` and `token == "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"`.
- Spot deposits require `sourceDex == destinationDex == "spot"` and a token id matching `trigger.input.currency`.
- Decimal `sendAsset.amount` parses (with the trigger currency decimals) to `trigger.input.amount`.

## Signed payloads

The action signs two EIP-712 payloads. The nonce mapping uses domain `{ name: "RelayNonceMapping", version: "2", chainId: 1, verifyingContract: 0x0 }` with type `NonceMapping(chainId string, wallet address, depositor address, id bytes32, nonce uint256)`. The `sendAsset` uses Hyperliquid's `HyperliquidSignTransaction` domain at the request's `signatureChainId` and the standard `HyperliquidTransaction:SendAsset` schema. Both signatures recover to the deposit wallet.

## Sign response

```ts
{
  nonceMapping: { digest: string, signature: string },
  sendAsset:    { digest: string, signature: string },
}
```

## Solver-side authorization and submission

Before posting the signed `sendAsset` to Hyperliquid, the solver must authorize the nonce mapping through the solver API so the nonce is attested and recorded on the Hub.

`POST /authorize?signature=<nonceMapping.signature>` with body:

```json
{
  "type": "nonce-mapping",
  "walletChainId": 1337,
  "wallet": "0x<deposit wallet>",
  "depositor": "0x<depositor>",
  "id": "0x<order id>",
  "nonce": 1779707159509,
  "signatureChainId": 1
}
```

`walletChainId` here is the solver-internal chain id (e.g. `1337` for Hyperliquid); the solver maps it to the protocol slug used inside the signed payload. After authorization succeeds, submit the signed `sendAsset` to Hyperliquid `/exchange` with Hyperliquid's expected `{ r, s, v }` signature shape.
