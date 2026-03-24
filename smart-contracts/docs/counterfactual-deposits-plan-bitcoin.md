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
    uint64 _maxFeeRate               // Maximum allowed fee rate (sats/vbyte)
) Ownable(_owner)
```

### Storage

| Variable                | Type     | Mutability              | Description                           |
| ----------------------- | -------- | ----------------------- | ------------------------------------- |
| `depositoryScriptBytes` | `bytes`  | set once in constructor | Decoded depository P2PKH scriptPubKey |
| `maxFeeRate`            | `uint64` | owner-configurable      | Maximum allowed fee rate (sats/vbyte) |

### Access Control

- `setMaxFeeRate()` — **onlyOwner** (update fee rate cap as market conditions change)
- All view/pure functions — **permissionless**

### Public / External Functions

#### `setMaxFeeRate(uint64 _maxFeeRate)` — onlyOwner

Updates the maximum allowed fee rate. Emits `MaxFeeRateChanged(_maxFeeRate)`.

#### `buildSweepPayload(bytes32 orderId, bytes calldata data) → (bytes memory payload, uint64 sweepAmount)` (view)

Decodes `data` as `abi.decode(data, (UTXO, uint64))` to extract the UTXO and fee rate. Validates the UTXO's scriptPubKey is a valid native P2WPKH witness program (exactly 22 bytes starting with `0x0014`). Builds the sweep transaction payload for a single UTXO. Returns ABI-encoded `BitcoinTransactionData` and the sweep amount (for event emission by the manager).

**Reverts**:

- `InvalidScriptPubKey()` if the UTXO's scriptPubKey is not a valid P2WPKH witness program
- `FeeRateTooHigh(feeRate, maxFeeRate)` if feeRate exceeds the owner-set cap
- `InsufficientUTXOValue(totalInput, fees)` if UTXO value doesn't cover fees
- `SweepAmountBelowDust(sweepAmount)` if depository output would be below 546 sats

#### `hashToSign(bytes calldata payload) → bytes32` (pure)

Returns double-SHA256 of the BIP143 SIGHASH_ALL preimage for the single input (index 0). The BIP143 preimage commits to the input value, preventing value manipulation attacks.

### Sweep Transaction Structure

Always exactly **1 input** and **2 outputs**, no change. The deposit UTXO must be a native P2WPKH output (`bc1q...` address):

| Input                    | Source                                       |
| ------------------------ | -------------------------------------------- |
| 0: Deposit UTXO (P2WPKH) | The single UTXO at the deterministic address |

| Output                | Value               | Script                                     |
| --------------------- | ------------------- | ------------------------------------------ |
| 0: Depository (P2PKH) | `utxo.value - fees` | `depositoryScriptBytes`                    |
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

With a single P2WPKH input, the transaction virtual size is fixed. SegWit uses virtual bytes (vbytes) where witness data is discounted at 1/4 weight:

```
fees = feeRate × 191 vbytes
```

Weight breakdown:

- **Non-witness (×4 weight):** 162 bytes = 4 version + 1 input count + 41 input (32 txid + 4 vout + 1 empty scriptSig length + 4 sequence) + 1 output count + 34 P2PKH output + 77 OP_RETURN output + 4 locktime → 648 weight units
- **Witness (×1 weight):** 110 bytes = 2 marker+flag + 1 item count + 1 sig length + 72 DER signature + 1 pubkey length + 33 compressed pubkey → 110 weight units
- **Total weight:** 758 → ceil(758 / 4) = **190 vbytes**
- **Conservative constant: 191 vbytes** (accounts for 73-byte DER signature variability)

This is a ~30% fee reduction compared to the legacy 269-byte calculation.

### Internal Functions (BIP143 sighash)

The sweep builder uses BIP143 (SegWit v0) sighash instead of the legacy algorithm. Unlike the legacy sighash, BIP143 commits to the input value being spent, preventing value manipulation attacks.

- `buildInput(UTXO memory utxo)` — converts a single UTXO to a transaction input
- `buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput)` — BIP143 SIGHASH_ALL preimage
- `_hashPrevouts(inputs)` — SHA256d of all outpoints concatenated
- `_hashSequence(inputs)` — SHA256d of all sequences concatenated
- `_hashOutputs(outputs)` — SHA256d of all serialized outputs
- `_buildScriptCode(witnessProgram)` — derives P2WPKH scriptCode (`0x1976a914<20-byte-hash>88ac`) from the witness program
- `encodeVarInt(uint256 value)` — CompactSize varint encoding

#### BIP143 Preimage Structure

```
nVersion        (4B LE)
hashPrevouts    SHA256d(all outpoints)                   32B
hashSequence    SHA256d(all sequences)                   32B
outpoint        txid (32B) + vout (4B LE)
scriptCode      0x19 76 a9 14 <20B pubkey hash> 88 ac   26B
value           input value (8B LE)                      ← commits to value
nSequence       (4B LE = 0xFFFFFFFD)
hashOutputs     SHA256d(all serialized outputs)          32B
nLocktime       (4B LE = 0)
nHashType       (4B LE = 0x01 SIGHASH_ALL)
```

### Custom Errors

```solidity
error InvalidScriptPubKey();
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

| Variable            | Type                                              | Mutability              | Description                            |
| ------------------- | ------------------------------------------------- | ----------------------- | -------------------------------------- |
| `sweepBuilder`      | `IBitcoinDepositSweepBuilder`                     | owner-configurable      | Current sweep payload builder contract |
| `nearSigner`        | `string`                                          | set once in constructor | NEAR MPC signer account                |
| `near`              | `NEAR`                                            | set once in constructor | Aurora SDK instance                    |
| `sweepPayloads`     | `mapping(bytes32 => mapping(bytes32 => bytes))`   | mutable                 | orderId → hashToSign → encoded payload |
| `signedPayloads`    | `mapping(bytes32 => mapping(bytes32 => bytes))`   | mutable                 | orderId → hashToSign → signature       |
| `pendingSignatures` | `mapping(bytes32 => mapping(bytes32 => uint256))` | mutable                 | Cooldown tracking                      |

### Access Control

- `init()` — **onlyOwner** (one-time bootstrap, costs 2 wNEAR)
- `setSweepBuilder()` — **onlyOwner** (swap the payload builder)
- `sweep()` — **permissionless** (anyone can submit; funds always go to the depository)
- All view/pure functions — **permissionless**

Since the depository is determined by the builder and all sweep outputs always go there, permissionless access is safe — there is no way for a caller to redirect funds. The BIP143 sighash commits to the input value, so a caller cannot manipulate the UTXO value to burn funds as excess miner fees.

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

The caller does not need to approve or transfer wNEAR for `sweep()`. The NEAR MPC
signature fee is paid from the `BitcoinDepositAddress` contract's own balance via
the Aurora XCC flow. Each signing request costs only 1 wei, so even if the
contract holds more than 1 wei, repeated permissionless spam is not expected to be
a practical drain vector as long as the contract remains funded.

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

### BIP143 Internal Functions (in `BitcoinDepositSweepBuilder`)

The sweep builder uses its own BIP143 sighash implementation (not shared with `BitcoinPayloadBuilder` which still uses legacy sighash for the withdrawal path):

- `buildInput(UTXO memory utxo)` — converts a single UTXO to a transaction input
- `buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput)` — BIP143 SIGHASH_ALL preimage
- `_hashPrevouts`, `_hashSequence`, `_hashOutputs` — BIP143 hash components
- `_buildScriptCode` — derives P2WPKH scriptCode from witness program
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

## Implementation History

The two-contract architecture was implemented first, followed by a BIP143 sighash migration to fix a value manipulation vulnerability.

### Phase 1: Two-Contract Architecture (completed)

1. Created `contracts/BitcoinDepositSweepBuilder.sol` with `IBitcoinDepositSweepBuilder` interface
2. Refactored `BitcoinDepositAddress.sol` as the manager contract with opaque data passing
3. Updated tests and Ignition deployment modules

### Phase 2: BIP143 Sighash Migration (completed)

Migrated the sweep builder from legacy Bitcoin sighash to BIP143 (SegWit v0) to fix a critical vulnerability where the legacy sighash does not commit to input values, allowing an attacker to provide a deflated UTXO value via the permissionless `sweep()` function.

Changes:

1. Replaced legacy `buildPreImageForInput` with BIP143 preimage (commits to input value)
2. Added P2WPKH scriptPubKey validation (`InvalidScriptPubKey` error)
3. Updated `SWEEP_TX_SIZE` from 269 bytes to 191 vbytes (SegWit fee discount)
4. Updated fee rate unit semantics from sats/byte to sats/vbyte
5. Switched test validation from `hashForSignature` to `hashForWitnessV0`
6. Added vulnerability regression tests

## Verification

```bash
cd smart-contracts
yarn build          # Both contracts compile
yarn test test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts  # Tests pass
yarn lint           # No lint errors
```
