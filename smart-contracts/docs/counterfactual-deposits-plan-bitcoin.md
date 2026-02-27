# BitcoinDepositAddress — Two-Contract Architecture Plan

## Context

The Relay Settlement Protocol needs a Bitcoin deposit sweep mechanism. Given a 32-byte order ID, the system generates a deterministic Bitcoin deposit address (via NEAR MPC path derivation), builds a sweep transaction that sends all deposited funds to a depository address, and tags the order ID via an OP_RETURN output. The system also handles NEAR MPC signing but does NOT broadcast the final transaction — that's handled by an external service.

Each deposit address holds exactly **one UTXO** — the single deposit. This simplifies the contract: one UTXO in, one sweep out, one MPC signature needed.

## Why Two Contracts?

The deterministic Bitcoin deposit address is derived from `address(this)` of the manager contract. If payload-building logic is embedded in the same contract, any change to how sweep transactions are constructed requires redeploying the manager — which changes all derived addresses.

By splitting into two contracts:

- **`BitcoinDepositAddress`** (manager) — owns the deterministic address derivation, signing state, and NEAR MPC interactions. Its address is stable and never redeployed.
- **`BitcoinDepositSweepBuilder`** (builder) — handles sweep transaction construction. Can be swapped out to change payload format without affecting derived addresses.

This mirrors the `RelayAllocator` + `IPayloadBuilder` pattern used for cross-chain withdrawals.

## Opaque Data Passing

The manager's `sweep()` function accepts opaque `bytes data` instead of typed parameters (like `UTXO` and `feeRate`). The manager passes this blob straight through to the builder, which decodes it internally. This ensures the manager never needs to change when the builder's input format evolves — future builders can expect completely different data shapes.

## Architecture

```
User deposits BTC → deterministic address (derived from BitcoinDepositAddress.address + orderId)
                          ↓
         Off-chain detects UTXO at address
                          ↓
         sweep(orderId, data, gasSettings)   ← callable by anyone
                          ↓
         BitcoinDepositAddress passes (orderId, data) to BitcoinDepositSweepBuilder
                          ↓
         Builder decodes data, returns payload; manager stores it, computes hash, calls NEAR MPC
                          ↓
         NEAR MPC callback stores signature
                          ↓
         External service reads signature, builds raw tx, broadcasts
```

---

## Contract 1: `BitcoinDepositSweepBuilder`

**Location**: `smart-contracts/contracts/BitcoinDepositSweepBuilder.sol`
**Inherits**: `Ownable` (from OpenZeppelin)
**Role**: Sweep transaction builder. Holds depository config and fee validation. Implements `IBitcoinDepositSweepBuilder`.

### Interface

```solidity
interface IBitcoinDepositSweepBuilder {
    /// @notice Builds a sweep payload from opaque data
    /// @param orderId The 32-byte order identifier
    /// @param data Builder-specific encoded parameters (this builder expects abi.encode(UTXO, uint64 feeRate))
    /// @return payload ABI-encoded BitcoinTransactionData
    /// @return sweepAmount The amount being swept to the depository (for event emission by the manager)
    function buildSweepPayload(
        bytes32 orderId,
        bytes calldata data
    ) external view returns (bytes memory payload, uint64 sweepAmount);

    /// @notice Returns the hash that needs to be signed for the payload
    /// @param payload The payload returned by buildSweepPayload
    /// @return The hash to sign
    function hashToSign(bytes calldata payload) external pure returns (bytes32);
}
```

The `data` parameter is opaque to the manager. This builder expects `abi.encode(UTXO, uint64)` (a UTXO struct and a fee rate), but future builders can define their own encoding.

### Constructor

```solidity
constructor(
    address _owner,
    string memory _depositoryScript, // Base64-encoded P2PKH scriptPubKey of depository
    uint64 _maxFeeRate               // Maximum allowed fee rate (sats/byte)
) Ownable(_owner)
```

### Storage

| Variable                | Type     | Mutability              | Description                                   |
| ----------------------- | -------- | ----------------------- | --------------------------------------------- |
| `depositoryScriptBytes` | `bytes`  | set once in constructor | Decoded depository P2PKH scriptPubKey          |
| `maxFeeRate`            | `uint64` | owner-configurable      | Maximum allowed fee rate (sats/byte)           |

### Access Control

- `setMaxFeeRate()` — **onlyOwner** (update fee rate cap as market conditions change)
- All view/pure functions — **permissionless**

### Public / External Functions

#### `setMaxFeeRate(uint64 _maxFeeRate)` — onlyOwner

Updates the maximum allowed fee rate. Emits `MaxFeeRateChanged(_maxFeeRate)`.

#### `buildSweepPayload(bytes32 orderId, bytes calldata data) → (bytes memory payload, uint64 sweepAmount)` (view)

Decodes `data` as `abi.decode(data, (UTXO, uint64))` to extract the UTXO and fee rate. Builds the sweep transaction payload for a single UTXO. Returns ABI-encoded `BitcoinTransactionData` and the sweep amount (for event emission by the manager).

**Reverts**:

- `FeeRateTooHigh(feeRate, maxFeeRate)` if feeRate exceeds the owner-set cap
- `InsufficientUTXOValue(totalInput, fees)` if UTXO value doesn't cover fees
- `SweepAmountBelowDust(sweepAmount)` if depository output would be below 546 sats

#### `hashToSign(bytes calldata payload) → bytes32` (pure)

Returns double-SHA256 of the SIGHASH_ALL preimage for the single input (index 0).

### Sweep Transaction Structure

Always exactly **1 input** and **2 outputs**, no change:

| Input           | Source                                       |
| --------------- | -------------------------------------------- |
| 0: Deposit UTXO | The single UTXO at the deterministic address |

| Output                | Value               | Script                           |
| --------------------- | ------------------- | -------------------------------- |
| 0: Depository (P2PKH) | `utxo.value - fees` | `depositoryScriptBytes`          |
| 1: OP_RETURN          | 0 sats              | `0x6a 0x42 "0x" <hex(orderId)>` (68 bytes) |

#### OP_RETURN Script

```
0x6a   — OP_RETURN opcode
0x42   — PUSH 66 bytes
"0x"   — 2-byte ASCII prefix
<64B>  — order ID as lowercase hex string (via ChainSignatures.stringifyBytes)
```

Total script: 68 bytes. Output is unspendable with value 0.

#### Fee Calculation

With a single input, the transaction size is fixed:

```
txSize = 148 + 121 = 269 bytes
fees   = feeRate × 269
```

Breakdown of the `121` constant:

- 34 bytes — P2PKH output (depository): 8 value + 1 varint + 25 scriptPubKey
- 77 bytes — OP_RETURN output: 8 value + 1 varint + 68 script
- 10 bytes — overhead: 4 version + 1 input count varint + 1 output count varint + 4 locktime

The single P2PKH input is 148 bytes: 32 txid + 4 vout + 1 scriptSig length varint + 107 scriptSig + 4 sequence.

### Internal Functions (duplicated from BitcoinPayloadBuilder)

These are copied rather than extracted to a shared library, to avoid modifying the deployed `BitcoinPayloadBuilder` contract:

- `buildInput(UTXO memory utxo)` — converts a single UTXO to a transaction input
- `buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput)` — SIGHASH_ALL preimage
- `encodeVarInt(uint256 value)` — CompactSize varint encoding

### Custom Errors

```solidity
error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
error SweepAmountBelowDust(uint64 sweepAmount);
```

### Events

```solidity
event MaxFeeRateChanged(uint64 maxFeeRate);
```

---

## Contract 2: `BitcoinDepositAddress`

**Location**: `smart-contracts/contracts/BitcoinDepositAddress.sol`
**Inherits**: `Ownable` (from OpenZeppelin)
**Role**: Manager contract. Owns the deterministic address derivation (its `address(this)` is part of the NEAR MPC derivation path), manages signing state, and delegates payload construction to a configurable `IBitcoinDepositSweepBuilder`. Treats builder input as opaque `bytes data`.

### Constructor

```solidity
constructor(
    address _owner,
    address _sweepBuilder,         // IBitcoinDepositSweepBuilder address
    string memory _nearSigner,     // NEAR MPC signer account
    address _wNEAR                 // Wrapped NEAR token address
) Ownable(_owner)
```

### Storage

| Variable              | Type                                              | Mutability              | Description                                                  |
| --------------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `sweepBuilder`        | `IBitcoinDepositSweepBuilder`                     | owner-configurable      | Current sweep payload builder contract                       |
| `nearSigner`          | `string`                                          | set once in constructor | NEAR MPC signer account                                      |
| `near`                | `NEAR`                                            | set once in constructor | Aurora SDK instance                                          |
| `sweepPayloads`       | `mapping(bytes32 => mapping(bytes32 => bytes))`   | mutable                 | orderId → hashToSign → encoded payload                       |
| `signedPayloads`      | `mapping(bytes32 => mapping(bytes32 => bytes))`   | mutable                 | orderId → hashToSign → signature                             |
| `pendingSignatures`   | `mapping(bytes32 => mapping(bytes32 => uint256))` | mutable                 | Cooldown tracking                                            |

### Access Control

- `init()` — **onlyOwner** (one-time bootstrap, costs 2 wNEAR)
- `setSweepBuilder()` — **onlyOwner** (swap the payload builder)
- `sweep()` — **permissionless** (anyone can submit; funds always go to the depository)
- All view/pure functions — **permissionless**

Since the depository is determined by the builder and all sweep outputs always go there, permissionless access is safe — there is no way for a caller to redirect funds.

### Public / External Functions

#### `init()` — onlyOwner

Bootstrap XCC sub-account on NEAR. Same pattern as `RelayAllocator.init()` and `RelayMultisigSigner.init()`.

#### `setSweepBuilder(address _sweepBuilder)` — onlyOwner

Updates the sweep builder contract address. Emits `SweepBuilderChanged(_sweepBuilder)`.

#### `derivationPath(bytes32 orderId) → string memory` (view)

Returns `hex(address(this)) + "/" + hex(orderId)` — the NEAR MPC derivation path for a given order. This path is used both for address generation (off-chain) and signing (on-chain).

#### `sweep(bytes32 orderId, bytes calldata data, GasSettings calldata gasSettings)` — permissionless

Combined submit-and-sign function. The `data` parameter is opaque — passed straight through to the builder without decoding. In a single call:

1. Delegates to `sweepBuilder.buildSweepPayload(orderId, data)` to get the payload and sweep amount
2. Computes `hashToSign` via `sweepBuilder.hashToSign(payload)`
3. Stores the payload in `sweepPayloads[orderId][hash]`
4. Computes the per-order derivation path
5. Calls NEAR MPC to sign the hash

Caller must have approved sufficient wNEAR for the NEAR MPC signature fee.

**Reverts**: builder reverts propagate (FeeRateTooHigh, InsufficientUTXOValue, SweepAmountBelowDust), plus:

- `SignatureAlreadyComplete(orderId, hashToSign)` if already signed
- `SignaturePending(orderId, expiration)` if a signing request is in-flight

**Emits**: `SweepSubmitted(orderId, payload, sweepAmount)`

#### `sweepCallback(bytes32 orderId, bytes32 hashToSign)` (external)

NEAR callback — stores the resulting signature. Only callable by the XCC implicit address.

**Emits**: `SweepSigned(orderId, hashToSign, signature)`

### Signing Flow Detail

The key property: the derivation path uses `address(this)` of the **manager** contract (`BitcoinDepositAddress`), not the builder. This is what makes the derived Bitcoin addresses stable across builder upgrades.

```solidity
// BitcoinDepositAddress (per-order path, stable across builder swaps):
path = string.concat(
    Strings.toHexString(uint160(address(this)), 20),
    "/",
    ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
);
```

The `sweep()` call flow:

1. Calls `sweepBuilder.buildSweepPayload(orderId, data)` → (payload, sweepAmount)
2. Calls `sweepBuilder.hashToSign(payload)` → hash
3. Stores payload in `sweepPayloads[orderId][hash]`
4. Emits `SweepSubmitted(orderId, payload, sweepAmount)`
5. Computes the per-order derivation path (using its own address)
6. Calls `ChainSignatures.encodeJSONRequest(hash, "Ecdsa", path, "0")`
7. Sends to NEAR MPC via Aurora SDK cross-contract call
8. Callback stores the signature

### Custom Errors

```solidity
error SignatureAlreadyComplete(bytes32 orderId, bytes32 hashToSign);
error SignaturePending(bytes32 orderId, uint256 expiration);
error SignCallbackFailed(bytes32 orderId);
```

### Events

```solidity
event SweepBuilderChanged(address sweepBuilder);
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

---

## Code Reuse Strategy

### Imported Structs (from `BitcoinPayloadBuilder.sol`, file-level declarations)

Used by the builder contract:

- `UTXO`, `BitcoinTransactionDataInput`, `BitcoinTransactionDataOutput`, `BitcoinTransactionData`

The manager contract does NOT import these — it treats builder data as opaque `bytes`.

### Duplicated Internal Functions (in `BitcoinDepositSweepBuilder`)

Copied from `BitcoinPayloadBuilder` rather than extracted to a shared library, to avoid modifying the deployed contract:

- `buildInput(UTXO memory utxo)` — converts a single UTXO to a transaction input
- `buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput)` — SIGHASH_ALL preimage
- `encodeVarInt(uint256 value)` — CompactSize varint encoding

### Imported Utilities

- `Utils.encodeUint32LE()`, `Utils.encodeUint64LE()` from `contracts/Utils.sol` (builder only)
- `ChainSignatures.encodeJSONRequest()`, `ChainSignatures.stringifyBytes()` from `contracts/ChainSignatures.sol` (manager + builder)
- Aurora SDK from `contracts/aurora-xcc/AuroraSdk.sol` (manager only)
- `Base64.decode()` from `solady` (builder only)

---

## Key Files to Reference

| File                                                      | Purpose                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `contracts/PayloadBuilders/BitcoinPayloadBuilder.sol`     | Struct imports + internal logic to duplicate                  |
| `contracts/RelayAllocator.sol`                            | Two-contract pattern reference (manager + payload builder)    |
| `contracts/RelayMultisigSigner.sol`                       | Simpler signing reference                                     |
| `contracts/ChainSignatures.sol`                           | `encodeJSONRequest`, `stringifyBytes`                         |
| `contracts/Utils.sol`                                     | `encodeUint32LE`, `encodeUint64LE`                            |
| `lib/bitcoin.ts`                                          | TypeScript ABI definitions, bitcoinjs-lib helpers for testing |
| `test/Allocator/PayloadBuilders/BitcoinPayloadBuilder.ts` | Test patterns to follow                                       |

## Implementation Steps

1. **Create `contracts/BitcoinDepositSweepBuilder.sol`** — the builder contract with `IBitcoinDepositSweepBuilder` interface, `buildSweepPayload(bytes32, bytes)`, `hashToSign`, `setMaxFeeRate`, and all duplicated internal functions. The `buildSweepPayload` decodes its `data` parameter as `abi.decode(data, (UTXO, uint64))`.
2. **Rename `contracts/BitcoinDepositAddressBuilder.sol` → `contracts/BitcoinDepositAddress.sol`** — refactor into the manager contract:
   - Remove all payload-building logic (move to builder)
   - Remove `depositoryScriptBytes` and `maxFeeRate` storage
   - Remove all Bitcoin transaction internals (`buildInput`, `buildPreImageForInput`, `encodeVarInt`)
   - Add `sweepBuilder` storage + `setSweepBuilder()` function
   - Change `sweep()` signature to accept opaque `bytes calldata data` instead of `UTXO calldata utxo, uint64 feeRate`
   - Update `sweep()` to delegate to `sweepBuilder.buildSweepPayload(orderId, data)` and `sweepBuilder.hashToSign(payload)`
   - Keep: `derivationPath()`, signing state, `_requestSignature()`, `sweepCallback()`, `init()`
3. **Update `test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts`** — refactor tests:
   - Deploy `BitcoinDepositSweepBuilder` first, then `BitcoinDepositAddress` with builder address
   - Move payload-building tests (fee validation, dust, outputs, hashToSign) to target the builder directly
   - Keep signing/state tests targeting the manager, encoding `(UTXO, feeRate)` as opaque bytes in test calls
   - Add tests for `setSweepBuilder()` (only owner, emits event)
4. **Update `ignition/modules/BitcoinDepositAddressBuilder.ts`** — deploy both contracts: builder first (with depository + maxFeeRate), then manager (with builder address + nearSigner + wNEAR)

## Verification

```bash
cd smart-contracts
yarn build          # Both contracts compile
yarn test test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts  # Tests pass
yarn lint           # No lint errors
```
