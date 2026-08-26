# Relay Settlement SDK

TypeScript SDK for encoding/decoding and passing messages accross the Relay Settlement Protocol.

## Installation

```bash
npm install @relay-protocol/settlement-sdk
# or
yarn add @relay-protocol/settlement-sdk
```

## Usage

### Orders

```typescript
import {
  encodeOrderCall,
  decodeOrderCall,
  getOrderId,
} from "@relay-protocol/settlement-sdk"

// Encode an order call
const encoded = encodeOrderCall({
  vmType: "ethereum-vm",
  call: {
    to: "0x...",
    data: "0x...",
    value: "1000000000000000000",
  },
})

// Decode an order call
const decoded = decodeOrderCall(encoded, "ethereum-vm")

// Get order ID
const orderId = getOrderId(order, chainsConfig)
```

### Address Encoding

```typescript
import {
  encodeAddress,
  decodeAddress,
  VmType,
} from "@relay-protocol/settlement-sdk"

// Encode address for a specific VM type
const encoded = encodeAddress("bc1q...", "bitcoin-vm")
const decoded = decodeAddress(encoded, "bitcoin-vm")
```

### Hedera identities

Hedera addresses every entity — accounts, HTS tokens, contracts — in a single
`shard.realm.num` id space, and identifies transactions by a payer-assigned
transaction id rather than by a hash. `src/hedera-vm.ts` holds the codecs for
both, so the solver, oracle, allocator and explorer paths all apply the same
identity rules.

```typescript
import {
  HEDERA_MAINNET_USDC_TOKEN_ID,
  encodeAddress,
  hederaEntityIdToEvmAddress,
  normalizeHederaTransactionReference,
  parseHederaAddress,
} from "@relay-protocol/settlement-sdk"

// Accounts and HTS tokens share the entity id codec
encodeAddress("0.0.456858", "hedera-vm") // 20-byte long-zero encoding
hederaEntityIdToEvmAddress(HEDERA_MAINNET_USDC_TOKEN_ID)
// "0x000000000000000000000000000000000006f89a"

// Validate a user-supplied address, checksum included, where the network is known
parseHederaAddress("0.0.456858-ojdqc", { network: "mainnet" })
```

**Addresses.** The approved forms are the canonical entity id (`0.0.1234`) and a
20-byte EVM address (`0x…`), in either the bare or mirror-node
`shard.realm.<40 hex>` spelling. Long-zero addresses normalize to the entity id
they encode, so an account and its long-zero address are one identity. Base32
public-key aliases are rejected: they are 32+ bytes, do not fit the protocol's
address slot, and must be resolved to an account id first. HBAR has no HTS
entity, so `0.0.0` is its native-currency sentinel and encodes to 20 zero bytes.

**Checksums are network-specific.** `0.0.456858` is `-ojdqc` on mainnet and
`-xwoxl` on testnet, so a checksum is only meaningful against a known network.
Pass `{ network }` to validate one; a checksummed value supplied without a
network is rejected rather than accepted unvalidated, and `encodeAddress` — which
has no network parameter — rejects checksummed input outright. Validate and strip
checksums at the boundary where the network is known, then encode.

**Noncanonical values are rejected, not normalized**, so an identity always
compares equal to itself as a string: abbreviated entity ids (`456858`,
`0.456858`), leading zeros, and timestamps whose nanoseconds are not spelled out
to nine digits (`1616167056.5` is 5 nanoseconds to Hedera but reads as half a
second).

**The public transaction identifier is the transaction id**, not the hash:

| Field                | Form                            | Assigned by                   | Use                                                             |
| -------------------- | ------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `transactionId`      | `0.0.1234@1616167056.535000000` | payer, before submission      | The public identifier. Expose it in APIs and key records by it. |
| `transactionHash`    | 48-byte SHA-384, `0x…`          | derived from the signed bytes | Submission evidence only — see below.                           |
| `consensusTimestamp` | `1618591023.997420021`          | network, at consensus         | Only known after success; distinct from the id's valid start.   |

The transaction hash digests the signed transaction bytes, which include the node
account the transaction was submitted to — so the same logical transaction
submitted to two nodes has two different hashes. It is 48 bytes rather than an
EVM hash's 32. Keep it in its own field and never treat it as the identity.

**Withdrawals** are direct `CryptoTransfer` transactions carrying HBAR or the
configured HTS token. `getHederaVmTransactionBody` serializes the Hedera
transaction body a withdrawal signs, and the withdrawal id is its `keccak256`
digest — the value Hedera verifies an ECDSA secp256k1 signature against, so the
protocol's existing secp256k1 signer needs no Hedera-specific handling. The
bytes are identical to what the Hedera JavaScript SDK produces for the same
transfer, and `HederaVmPayloadBuilder.sol` reproduces them on-chain.

A submitter must wrap those exact bytes in a `SignedTransaction`: rebuilding an
equivalent transaction would produce a body the allocator's signature does not
cover. Recipients must be account ids rather than aliases — transferring to an
alias would have Hedera auto-create a hollow account, which is account creation
the protocol has not approved and an extra fee the submitter would pay.

The withdrawal names two separate accounts. `sender` is the depository, debited
the full amount; `payer` is the submitter, which pays the transaction fee and is
never debited. Hedera charges the fee to the transaction's payer rather than to
the account being debited, so the party that chooses to submit is the party that
bears the cost — the same arrangement as a relayer paying gas on an EVM chain.
That is why Hedera withdrawals require no pre-paid gas, and why the depository
can be swept to zero instead of retaining a fee reserve. The payer must never be
the depository, which the builder rejects.

A Hedera transaction id is the payer plus the valid start, and the network
rejects a repeat of one it has already seen. So the payload builder derives the
valid start's nanosecond component from the withdraw parameters rather than
taking it from the solver: two withdrawal requests that agree on payer, sender,
receiver, amount, token, node and valid-start second would otherwise share a
transaction id, and only the first could ever execute. The derived value arrives
in the decoded withdrawal's `validStart`, so a submitter reads it from the
payload rather than recomputing it.

The mirror node and explorers spell the transaction id with dashes
(`0.0.19789-1618591023-997420021`); that form carries neither the `scheduled`
flag nor the nonce. `parseHederaTransactionId` accepts both forms and
`toHederaMirrorNodeTransactionId` returns the dashed id together with the flag
and nonce the mirror node expects as separate query parameters, so the conversion
stays lossless. `normalizeHederaTransactionReference` canonicalizes all three
fields at once and is what every consumer should store.

### Hub Contract utils

```typescript
import {
  generateAddress,
  generateTokenId,
} from "@relay-protocol/settlement-sdk"

// Generate virtual address
const virtualAddress = generateAddress({
  family: "ethereum-vm",
  chainId: 1n,
  address: "0x...",
})

// Generate token ID
const tokenId = generateTokenId({
  family: "ethereum-vm",
  chainId: 1n,
  address: "0x...",
})
```

### Depository Contracts utils

```typescript
import {
  encodeWithdrawal,
  decodeWithdrawal,
  getExecutionMessageId,
} from "@relay-protocol/settlement-sdk"

// Encode/decode withdrawal messages
const encoded = encodeWithdrawal(decodedWithdrawal)
const decoded = decodeWithdrawal(encoded, vmType)

// Get an execution message ID
const executionId = getExecutionMessageId(message)
```

## Supported VM Types

- `bitcoin-vm`
- `ethereum-vm`
- `gateway-vm`
- `hedera-vm`
- `hyperliquid-vm`
- `lighter-vm`
- `solana-vm`
- `ton-vm`
- `tron-vm`
- `xrp-vm`

Every VM type has address and token identity codecs and a withdrawal payload
codec. `WithdrawalVmType` excludes the VM types listed in
`PendingWithdrawalVmType` — those whose on-chain payload builder has not shipped
yet — which is empty today.

## Adding a New VM

Withdrawal support for each VM lives in its own module under
`src/messages/v2.1/withdrawals/`. To add a VM:

1. Add the VM to the `VmType` union in `src/utils.ts`, along with its
   `encodeAddress` / `decodeAddress` cases and its native currency.
2. Create `src/messages/v2.1/withdrawals/<vm>.ts` exporting a
   `DecodedXxxVmWithdrawal` type and a `WithdrawalCodec` implementation. For
   ABI-encoded payloads, declare the ABI parameters once with
   `parseAbiParameters` and build encode/decode with `defineAbiWithdrawalCodec`
   — the transforms are type-checked against the ABI schema, so the decoded
   type cannot drift from the encoding.
3. Register the codec in `src/messages/v2.1/withdrawals/index.ts` and add the
   type to the `DecodedWithdrawal` union (both are compile-enforced). If the VM's
   payload builder does not exist on-chain yet, list the VM in
   `PendingWithdrawalVmType` instead — that keeps the registry exhaustive without
   a placeholder codec that would encode payloads no allocator can sign.
4. Add round-trip and pinned-vector tests in `test/`, ideally referencing the
   corresponding on-chain payload builder's test vectors.

## API Reference

See the [TypeScript definitions](./dist/index.d.ts) for complete API documentation.
