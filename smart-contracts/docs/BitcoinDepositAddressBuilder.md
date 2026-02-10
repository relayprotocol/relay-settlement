# BitcoinDepositAddressBuilder Contract Plan

## Context

The Relay Settlement Protocol needs a Bitcoin deposit sweep mechanism. Given a 32-byte order ID, the contract generates a deterministic Bitcoin deposit address (via NEAR MPC path derivation), builds a sweep transaction that sends all deposited funds to a depository address, and tags the order ID via an OP_RETURN output. The contract also handles NEAR MPC signing but does NOT broadcast the final transaction — that's handled by an external service.

Each deposit address holds exactly **one UTXO** — the single deposit. This simplifies the contract: one UTXO in, one sweep out, one MPC signature needed.

## Architecture

```
User deposits BTC → deterministic address (derived from orderId)
                          ↓
         Off-chain detects UTXO at address
                          ↓
         sweep(orderId, utxo, feeRate, gasSettings)   ← callable by anyone
                          ↓
         Contract builds tx payload, stores it, computes hash, calls NEAR MPC
                          ↓
         NEAR MPC callback stores signature
                          ↓
         External service reads signature, builds raw tx, broadcasts
```

## Contract Overview

**Name**: `BitcoinDepositAddressBuilder`
**Location**: `smart-contracts/contracts/BitcoinDepositAddressBuilder.sol`
**Inherits**: `Ownable` (from OpenZeppelin)
**Does NOT** implement `IPayloadBuilder` — standalone contract.

## Constructor

```solidity
constructor(
    address _owner,
    string memory _depositoryScript, // Base64-encoded P2PKH scriptPubKey of depository
    string memory _nearSigner,       // NEAR MPC signer account
    address _wNEAR,                  // Wrapped NEAR token address
    uint64 _maxFeeRate               // Maximum allowed fee rate (sats/byte)
) Ownable(_owner)
```

### Storage

| Variable                | Type                                              | Mutability              | Description                                                  |
| ----------------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `depositoryScriptBytes` | `bytes`                                           | set once in constructor | Decoded depository P2PKH scriptPubKey                        |
| `nearSigner`            | `string`                                          | set once in constructor | NEAR MPC signer account                                      |
| `near`                  | `NEAR`                                            | set once in constructor | Aurora SDK instance                                          |
| `maxFeeRate`            | `uint64`                                          | owner-configurable      | Maximum allowed fee rate (sats/byte) to prevent fee griefing |
| `sweepPayloads`         | `mapping(bytes32 => bytes)`                       | mutable                 | orderId → encoded payload                                    |
| `signedPayloads`        | `mapping(bytes32 => mapping(bytes32 => bytes))`   | mutable                 | orderId → hashToSign → signature                             |
| `pendingSignatures`     | `mapping(bytes32 => mapping(bytes32 => uint256))` | mutable                 | Cooldown tracking                                            |

## Access Control

- `init()` — **onlyOwner** (one-time bootstrap, costs 2 wNEAR)
- `setMaxFeeRate()` — **onlyOwner** (update fee rate cap as market conditions change). Setting a max feed rate prevents grieving by Bitcoin miners.
- `sweep()` — **permissionless** (anyone can submit; funds always go to the depository)
- All view/pure functions — **permissionless**

Since the depository is immutable and all sweep outputs always go there, permissionless access is safe — there is no way for a caller to redirect funds. The `maxFeeRate` cap prevents fee griefing by malicious callers.

## Public / External Functions

### `init()` — onlyOwner

Bootstrap XCC sub-account on NEAR. Same pattern as `RelayAllocator.init()` and `RelayMultisigSigner.init()`.

### `setMaxFeeRate(uint64 _maxFeeRate)` — onlyOwner

Updates the maximum allowed fee rate. Setting a max feed rate prevents griefing by Bitcoin miners. Emits `MaxFeeRateChanged(_maxFeeRate)`.

### `derivationPath(bytes32 orderId) → string memory` (view)

Returns `hex(address(this)) + "/" + hex(orderId)` — the NEAR MPC derivation path for a given order. This path is used both for address generation (off-chain) and signing (on-chain).

### `buildSweepPayload(bytes32 orderId, UTXO calldata utxo, uint64 feeRate) → bytes memory` (view)

Builds the sweep transaction payload for a single UTXO. Pure computation, does not store anything. Returns ABI-encoded `BitcoinTransactionData`.

**Reverts**:

- `FeeRateTooHigh(feeRate, maxFeeRate)` if feeRate exceeds the owner-set cap
- `InsufficientUTXOValue(totalInput, fees)` if UTXO value doesn't cover fees
- `SweepAmountBelowDust(sweepAmount)` if depository output would be below 546 sats

### `sweep(bytes32 orderId, UTXO calldata utxo, uint64 feeRate, GasSettings calldata gasSettings)` — permissionless

Combined submit-and-sign function. In a single call:

1. Builds the sweep payload from the single UTXO via `buildSweepPayload()`
2. Stores the payload for later retrieval
3. Computes the single `hashToSign` for the only input
4. Computes the per-order derivation path
5. Calls NEAR MPC to sign the hash

Caller must have approved sufficient wNEAR for the NEAR MPC signature fee.

**Reverts**: same as `buildSweepPayload`, plus:

- `SweepAlreadySubmitted(orderId)` if already submitted
- `SignatureAlreadyComplete(orderId, hashToSign)` if already signed
- `SignaturePending(orderId, expiration)` if a signing request is in-flight

**Emits**: `SweepSubmitted(orderId, payload, sweepAmount)`

### `sweepCallback(bytes32 orderId, bytes32 hashToSign)` (external)

NEAR callback — stores the resulting signature. Only callable by the XCC implicit address.

**Emits**: `SweepSigned(orderId, hashToSign, signature)`

### `hashToSign(bytes calldata payload) → bytes32` (pure)

Returns double-SHA256 of the SIGHASH_ALL preimage for the single input (index 0). Used for verification or external signing workflows.

## Sweep Transaction Structure

Always exactly **1 input** and **2 outputs**, no change:

| Input           | Source                                       |
| --------------- | -------------------------------------------- |
| 0: Deposit UTXO | The single UTXO at the deterministic address |

| Output                | Value               | Script                           |
| --------------------- | ------------------- | -------------------------------- |
| 0: Depository (P2PKH) | `utxo.value - fees` | `depositoryScriptBytes`          |
| 1: OP_RETURN          | 0 sats              | `0x6a 0x20 <orderId>` (34 bytes) |

### OP_RETURN Script

```
0x6a   — OP_RETURN opcode
0x20   — PUSH 32 bytes
<32B>  — order ID
```

Total script: 34 bytes. Output is unspendable with value 0.

### Fee Calculation

With a single input, the transaction size is fixed:

```
txSize = 148 + 87 = 235 bytes
fees   = feeRate × 235
```

Breakdown of the `87` constant:

- 34 bytes — P2PKH output (depository): 8 value + 1 varint + 25 scriptPubKey
- 43 bytes — OP_RETURN output: 8 value + 1 varint + 34 script
- 10 bytes — overhead: 4 version + 1 input count varint + 1 output count varint + 4 locktime

The single P2PKH input is 148 bytes: 32 txid + 4 vout + 1 scriptSig length varint + 107 scriptSig + 4 sequence.

The `maxFeeRate` cap (set by owner via `setMaxFeeRate()`) prevents malicious callers from setting an excessively high fee rate that would burn deposited funds as miner fees.

## Signing Flow Detail

The key difference from `RelayAllocator` and `RelayMultisigSigner` is that this contract uses a **per-order derivation path** instead of a fixed `signerPath`:

```solidity
// RelayAllocator (fixed path):
signerPath = Strings.toHexString(uint160(address(this)), 20);

// BitcoinDepositAddressBuilder (per-order path):
path = string.concat(
    Strings.toHexString(uint160(address(this)), 20),
    "/",
    ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
);
```

The `sweep()` call handles everything atomically:

1. Builds the payload from the single UTXO
2. Stores it in `sweepPayloads[orderId]`
3. Computes `hashToSign(payload)` (always input index 0)
4. Computes the per-order derivation path
5. Calls `ChainSignatures.encodeJSONRequest(hash, "Ecdsa", path, "0")`
6. Sends to NEAR MPC via Aurora SDK cross-contract call
7. Callback stores the signature

## Code Reuse Strategy

### Imported Structs (from `BitcoinPayloadBuilder.sol`, file-level declarations)

- `UTXO`, `BitcoinTransactionDataInput`, `BitcoinTransactionDataOutput`, `BitcoinTransactionData`

### Duplicated Internal Functions (from `BitcoinPayloadBuilder.sol`)

These are copied rather than extracted to a shared library, to avoid modifying the deployed `BitcoinPayloadBuilder` contract:

- `buildInput(UTXO memory utxo)` — converts a single UTXO to a transaction input
- `buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput)` — SIGHASH_ALL preimage
- `encodeVarInt(uint256 value)` — CompactSize varint encoding

### Imported Utilities

- `Utils.encodeUint32LE()`, `Utils.encodeUint64LE()` from `contracts/Utils.sol`
- `ChainSignatures.encodeJSONRequest()`, `ChainSignatures.stringifyBytes()` from `contracts/ChainSignatures.sol`
- Aurora SDK from `contracts/aurora-xcc/AuroraSdk.sol`
- `Base64.decode()` from `solady`

## Custom Errors

```solidity
error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
error SweepAmountBelowDust(uint64 sweepAmount);
error SweepAlreadySubmitted(bytes32 orderId);
error SignatureAlreadyComplete(bytes32 orderId, bytes32 hashToSign);
error SignaturePending(bytes32 orderId, uint256 expiration);
error SignCallbackFailed(bytes32 orderId);
```

## Events

```solidity
event MaxFeeRateChanged(uint64 maxFeeRate);
event SweepSubmitted(
  bytes32 indexed orderId,
  bytes payload,
  uint64 sweepAmount
);
event SweepSigned(
  bytes32 indexed orderId,
  bytes32 indexed hashToSign,
  bytes signature
);
```

## Key Files to Reference

| File                                                      | Purpose                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `contracts/PayloadBuilders/BitcoinPayloadBuilder.sol`     | Struct imports + internal logic to duplicate                  |
| `contracts/RelayAllocator.sol`                            | Signing pattern (Aurora SDK, callback, pending cooldown)      |
| `contracts/RelayMultisigSigner.sol`                       | Simpler signing reference                                     |
| `contracts/ChainSignatures.sol`                           | `encodeJSONRequest`, `stringifyBytes`                         |
| `contracts/Utils.sol`                                     | `encodeUint32LE`, `encodeUint64LE`                            |
| `lib/bitcoin.ts`                                          | TypeScript ABI definitions, bitcoinjs-lib helpers for testing |
| `test/Allocator/PayloadBuilders/BitcoinPayloadBuilder.ts` | Test patterns to follow                                       |

## Implementation Steps

1. **Create `contracts/BitcoinDepositAddressBuilder.sol`** — the main contract with all functions above
2. **Create `test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts`** — tests covering:
   - `derivationPath()` — correct format, deterministic, unique per order
   - `buildSweepPayload()` — reverts on insufficient value, dust, fee rate too high; correct 2 outputs (depository + OP_RETURN); correct fee deduction
   - `hashToSign()` — cross-validated against bitcoinjs-lib SIGHASH_ALL
   - `sweep()` — stores payload, emits event, reverts on duplicate, triggers MPC signing
   - `setMaxFeeRate()` — only owner can call, emits event
   - Signing callback tests are unit-level only (Aurora SDK requires live fork)

## Verification

```bash
cd smart-contracts
yarn build          # Contract compiles
yarn test test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts  # Tests pass
yarn lint           # No lint errors
```
