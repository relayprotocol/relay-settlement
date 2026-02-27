# Bitcoin Deposit Address Two-Contract Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `BitcoinDepositAddressBuilder` into two contracts — a stable manager (`BitcoinDepositAddress`) and a swappable builder (`BitcoinDepositSweepBuilder`) — so the deterministic Bitcoin deposit addresses survive builder upgrades.

**Architecture:** The manager contract owns the NEAR MPC derivation path (via its `address(this)`), signing state, and callbacks. It delegates payload construction to a configurable builder via an interface, passing opaque `bytes data` straight through. The builder decodes the data internally and returns the payload + sweep amount.

**Tech Stack:** Solidity 0.8.28, Hardhat, Mocha/Chai, viem

**Design doc:** `smart-contracts/docs/counterfactual-deposits-plan-bitcoin.md`

---

### Task 1: Create `IBitcoinDepositSweepBuilder` Interface

**Files:**
- Create: `smart-contracts/contracts/interfaces/IBitcoinDepositSweepBuilder.sol`

**Step 1: Create the interface file**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBitcoinDepositSweepBuilder
/// @author Relay Protocol
/// @notice Interface for building Bitcoin sweep transaction payloads
interface IBitcoinDepositSweepBuilder {
    /// @notice Builds a sweep payload from opaque data
    /// @param orderId The 32-byte order identifier
    /// @param data Builder-specific encoded parameters
    /// @return payload ABI-encoded BitcoinTransactionData
    /// @return sweepAmount The amount being swept to the depository
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

**Step 2: Verify it compiles**

Run: `cd smart-contracts && yarn build`
Expected: Compilation succeeds

**Step 3: Commit**

```
feat: add IBitcoinDepositSweepBuilder interface
```

---

### Task 2: Create `BitcoinDepositSweepBuilder` Contract

**Files:**
- Create: `smart-contracts/contracts/BitcoinDepositSweepBuilder.sol`
- Reference: `smart-contracts/contracts/BitcoinDepositAddressBuilder.sol` (copy payload-building logic from here)

**Step 1: Create the builder contract**

Extract from `BitcoinDepositAddressBuilder.sol`:
- All payload-building logic: `buildSweepPayload()`, `hashToSign()`, `buildInput()`, `buildPreImageForInput()`, `encodeVarInt()`
- Storage: `depositoryScriptBytes`, `maxFeeRate`
- Function: `setMaxFeeRate()`
- Errors: `FeeRateTooHigh`, `InsufficientUTXOValue`, `SweepAmountBelowDust`
- Event: `MaxFeeRateChanged`
- Constructor params: `_owner`, `_depositoryScript`, `_maxFeeRate`

Key changes from the original:
- Implements `IBitcoinDepositSweepBuilder`
- `buildSweepPayload` signature changes: takes `(bytes32 orderId, bytes calldata data)` instead of `(bytes32 orderId, UTXO calldata utxo, uint64 feeRate)`. First line decodes: `(UTXO memory utxo, uint64 feeRate) = abi.decode(data, (UTXO, uint64))`
- `buildSweepPayload` returns `(bytes memory payload, uint64 sweepAmount)` instead of just `bytes memory`
- `hashToSign` takes `bytes calldata` (not `bytes memory`)
- No Aurora SDK imports, no signing state, no `derivationPath()`, no `sweep()`, no `sweepCallback()`, no `init()`

Imports needed:
- `Ownable` from OpenZeppelin
- `Base64` from solady
- `UTXO`, `BitcoinTransactionDataInput`, `BitcoinTransactionDataOutput`, `BitcoinTransactionData` from `BitcoinPayloadBuilder.sol`
- `Utils` from `Utils.sol`
- `ChainSignatures` from `ChainSignatures.sol` (for `stringifyBytes` in OP_RETURN encoding)
- `IBitcoinDepositSweepBuilder` from the interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import {ChainSignatures} from "./ChainSignatures.sol";
import {Utils} from "./Utils.sol";
import {IBitcoinDepositSweepBuilder} from "./interfaces/IBitcoinDepositSweepBuilder.sol";
import {
    UTXO,
    BitcoinTransactionDataInput,
    BitcoinTransactionDataOutput,
    BitcoinTransactionData
} from "./PayloadBuilders/BitcoinPayloadBuilder.sol";

/// @title BitcoinDepositSweepBuilder
/// @author Relay Protocol
/// @notice Builds Bitcoin sweep transaction payloads for deposit addresses
contract BitcoinDepositSweepBuilder is IBitcoinDepositSweepBuilder, Ownable {
    // ── Errors ──────────────────────────────────────────────────────────
    error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
    error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
    error SweepAmountBelowDust(uint64 sweepAmount);

    // ── Events ──────────────────────────────────────────────────────────
    event MaxFeeRateChanged(uint64 maxFeeRate);

    // ── Constants ───────────────────────────────────────────────────────
    uint64 private constant DUST_THRESHOLD = 546;
    uint256 private constant SWEEP_TX_SIZE = 269;

    // ── Storage ─────────────────────────────────────────────────────────
    bytes public depositoryScriptBytes;
    uint64 public maxFeeRate;

    // ── Constructor ─────────────────────────────────────────────────────
    constructor(
        address _owner,
        string memory _depositoryScript,
        uint64 _maxFeeRate
    ) Ownable(_owner) {
        depositoryScriptBytes = Base64.decode(_depositoryScript);
        maxFeeRate = _maxFeeRate;
    }

    // ── External / Public Functions ─────────────────────────────────────

    function setMaxFeeRate(uint64 _maxFeeRate) external onlyOwner {
        maxFeeRate = _maxFeeRate;
        emit MaxFeeRateChanged(_maxFeeRate);
    }

    /// @inheritdoc IBitcoinDepositSweepBuilder
    function buildSweepPayload(
        bytes32 orderId,
        bytes calldata data
    ) external view returns (bytes memory payload, uint64 sweepAmount) {
        (UTXO memory utxo, uint64 feeRate) = abi.decode(data, (UTXO, uint64));

        if (feeRate > maxFeeRate) {
            revert FeeRateTooHigh(feeRate, maxFeeRate);
        }

        uint256 fees = uint256(feeRate) * SWEEP_TX_SIZE;
        if (utxo.value < fees) {
            revert InsufficientUTXOValue(utxo.value, fees);
        }

        sweepAmount = utxo.value - uint64(fees);
        if (sweepAmount < DUST_THRESHOLD) {
            revert SweepAmountBelowDust(sweepAmount);
        }

        BitcoinTransactionDataInput[] memory inputs = new BitcoinTransactionDataInput[](1);
        inputs[0] = buildInput(utxo);

        BitcoinTransactionDataOutput[] memory outputs = new BitcoinTransactionDataOutput[](2);

        outputs[0] = BitcoinTransactionDataOutput({
            value: Utils.encodeUint64LE(sweepAmount),
            script: depositoryScriptBytes
        });

        outputs[1] = BitcoinTransactionDataOutput({
            value: Utils.encodeUint64LE(0),
            script: abi.encodePacked(
                hex"6a42",
                "0x",
                ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
            )
        });

        payload = abi.encode(BitcoinTransactionData({inputs: inputs, outputs: outputs}));
    }

    /// @inheritdoc IBitcoinDepositSweepBuilder
    function hashToSign(bytes calldata payload) external pure returns (bytes32) {
        BitcoinTransactionData memory txData = abi.decode(payload, (BitcoinTransactionData));
        bytes memory pre = buildPreImageForInput(txData, 0);
        return sha256(abi.encodePacked(sha256(pre)));
    }

    // ── Internal Functions (duplicated from BitcoinPayloadBuilder) ──────
    // Copied verbatim from BitcoinDepositAddressBuilder.sol — these are
    // identical to BitcoinPayloadBuilder's internal functions.

    function buildInput(UTXO memory utxo) internal pure returns (BitcoinTransactionDataInput memory) {
        // Copy from BitcoinDepositAddressBuilder.sol lines 324-334
    }

    function buildPreImageForInput(BitcoinTransactionData memory txData, uint256 whichInput) internal pure returns (bytes memory) {
        // Copy from BitcoinDepositAddressBuilder.sol lines 340-401
    }

    function encodeVarInt(uint256 value) internal pure returns (bytes memory) {
        // Copy from BitcoinDepositAddressBuilder.sol lines 406-439
    }
}
```

The three internal functions (`buildInput`, `buildPreImageForInput`, `encodeVarInt`) should be copied verbatim from `BitcoinDepositAddressBuilder.sol` lines 324-439.

**Step 2: Verify it compiles**

Run: `cd smart-contracts && yarn build`
Expected: Compilation succeeds

**Step 3: Commit**

```
feat: add BitcoinDepositSweepBuilder contract
```

---

### Task 3: Refactor `BitcoinDepositAddressBuilder` → `BitcoinDepositAddress`

**Files:**
- Delete: `smart-contracts/contracts/BitcoinDepositAddressBuilder.sol`
- Create: `smart-contracts/contracts/BitcoinDepositAddress.sol`

**Step 1: Create the manager contract**

Keep from `BitcoinDepositAddressBuilder.sol`:
- `derivationPath()` — unchanged
- `init()` — unchanged
- `_requestSignature()` — unchanged
- `sweepCallback()` — unchanged
- Signing state: `sweepPayloads`, `signedPayloads`, `pendingSignatures`
- Errors: `SignatureAlreadyComplete`, `SignaturePending`, `SignCallbackFailed`
- Events: `SweepSubmitted`, `SweepSigned`
- Constants: `PENDING_SIGNATURE_COOLDOWN`
- Aurora SDK imports and setup

Add:
- `sweepBuilder` storage (`IBitcoinDepositSweepBuilder`)
- `setSweepBuilder(address)` function + `SweepBuilderChanged` event
- Constructor takes `_sweepBuilder` instead of `_depositoryScript` and `_maxFeeRate`

Remove:
- `depositoryScriptBytes`, `maxFeeRate` storage
- `setMaxFeeRate()`
- `buildSweepPayload()`, `hashToSign()` (moved to builder)
- `buildInput()`, `buildPreImageForInput()`, `encodeVarInt()` (moved to builder)
- `Base64` import, `Utils` import
- `UTXO`, `BitcoinTransactionData*` struct imports
- `DUST_THRESHOLD`, `SWEEP_TX_SIZE` constants
- `FeeRateTooHigh`, `InsufficientUTXOValue`, `SweepAmountBelowDust` errors
- `MaxFeeRateChanged` event

Change `sweep()` signature and body:
- Old: `sweep(bytes32 orderId, UTXO calldata utxo, uint64 feeRate, GasSettings calldata gasSettings)`
- New: `sweep(bytes32 orderId, bytes calldata data, GasSettings calldata gasSettings)`
- Body delegates to builder:

```solidity
function sweep(
    bytes32 orderId,
    bytes calldata data,
    GasSettings calldata gasSettings
) external {
    (bytes memory payload, uint64 sweepAmount) = sweepBuilder.buildSweepPayload(orderId, data);
    bytes32 hash = sweepBuilder.hashToSign(payload);

    sweepPayloads[orderId][hash] = payload;

    emit SweepSubmitted(orderId, payload, sweepAmount);

    _requestSignature(orderId, hash, gasSettings);
}
```

Full contract:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {
    AuroraSdk,
    NEAR,
    PromiseCreateArgs,
    PromiseResult,
    PromiseResultStatus,
    PromiseWithCallback
} from "./aurora-xcc/AuroraSdk.sol";
import {ChainSignatures} from "./ChainSignatures.sol";
import {IBitcoinDepositSweepBuilder} from "./interfaces/IBitcoinDepositSweepBuilder.sol";
import {GasSettings} from "./RelayAllocator.sol";

/// @title BitcoinDepositAddress
/// @author Relay Protocol
/// @notice Manager contract for deterministic Bitcoin deposit addresses.
/// Owns the NEAR MPC derivation path and delegates payload construction
/// to a configurable IBitcoinDepositSweepBuilder.
contract BitcoinDepositAddress is Ownable {
    using AuroraSdk for NEAR;
    using AuroraSdk for PromiseCreateArgs;
    using AuroraSdk for PromiseWithCallback;
    using AuroraSdk for PromiseResult;

    // ── Errors ──────────────────────────────────────────────────────────
    error SignatureAlreadyComplete(bytes32 orderId, bytes32 hashToSign);
    error SignaturePending(bytes32 orderId, uint256 expiration);
    error SignCallbackFailed(bytes32 orderId);

    // ── Events ──────────────────────────────────────────────────────────
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

    // ── Constants ───────────────────────────────────────────────────────
    uint256 private constant PENDING_SIGNATURE_COOLDOWN = 5 minutes;

    // ── Storage ─────────────────────────────────────────────────────────
    IBitcoinDepositSweepBuilder public sweepBuilder;
    string public nearSigner;
    NEAR public near;
    mapping(bytes32 => mapping(bytes32 => bytes)) public sweepPayloads;
    mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;
    mapping(bytes32 => mapping(bytes32 => uint256)) public pendingSignatures;

    // ── Constructor ─────────────────────────────────────────────────────
    constructor(
        address _owner,
        address _sweepBuilder,
        string memory _nearSigner,
        address _wNEAR
    ) Ownable(_owner) {
        sweepBuilder = IBitcoinDepositSweepBuilder(_sweepBuilder);
        nearSigner = _nearSigner;
        near = AuroraSdk.initNear(IERC20(_wNEAR));
    }

    // ── External / Public Functions ─────────────────────────────────────

    function init() external onlyOwner {
        near.wNEAR.transferFrom(
            msg.sender,
            address(this),
            uint256(2_000_000_000_000_000_000_000_000)
        );
        PromiseCreateArgs memory initCall = near.call("system", "", "", 0, 500_000_000_000);
        initCall.transact();
    }

    function setSweepBuilder(address _sweepBuilder) external onlyOwner {
        sweepBuilder = IBitcoinDepositSweepBuilder(_sweepBuilder);
        emit SweepBuilderChanged(_sweepBuilder);
    }

    function derivationPath(bytes32 orderId) public view returns (string memory) {
        return string.concat(
            Strings.toHexString(uint160(address(this)), 20),
            "/",
            ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
        );
    }

    function sweep(
        bytes32 orderId,
        bytes calldata data,
        GasSettings calldata gasSettings
    ) external {
        (bytes memory payload, uint64 sweepAmount) = sweepBuilder.buildSweepPayload(orderId, data);
        bytes32 hash = sweepBuilder.hashToSign(payload);

        sweepPayloads[orderId][hash] = payload;

        emit SweepSubmitted(orderId, payload, sweepAmount);

        _requestSignature(orderId, hash, gasSettings);
    }

    function sweepCallback(bytes32 orderId, bytes32 _hashToSign) external {
        if (msg.sender != AuroraSdk.nearRepresentitiveImplicitAddress(address(this))) {
            revert SignCallbackFailed(orderId);
        }
        PromiseResult memory result = AuroraSdk.promiseResult(0);
        if (result.status != PromiseResultStatus.Successful) {
            revert SignCallbackFailed(orderId);
        }
        signedPayloads[orderId][_hashToSign] = result.output;
        emit SweepSigned(orderId, _hashToSign, result.output);
    }

    // ── Internal Functions ──────────────────────────────────────────────

    function _requestSignature(
        bytes32 orderId,
        bytes32 hash,
        GasSettings calldata gasSettings
    ) internal {
        if (signedPayloads[orderId][hash].length > 0) {
            revert SignatureAlreadyComplete(orderId, hash);
        }
        uint256 expiration = pendingSignatures[orderId][hash];
        if (block.timestamp < expiration) {
            revert SignaturePending(orderId, expiration);
        }
        pendingSignatures[orderId][hash] = block.timestamp + PENDING_SIGNATURE_COOLDOWN;

        string memory path = derivationPath(orderId);
        bytes memory data = ChainSignatures.encodeJSONRequest(
            ChainSignatures.stringifyBytes(abi.encodePacked(hash)),
            "Ecdsa",
            path,
            "0"
        );

        PromiseCreateArgs memory callSign = near.call(nearSigner, "sign", data, 1, gasSettings.signGas);
        PromiseCreateArgs memory callback = near.auroraCall(
            address(this),
            abi.encodeWithSelector(this.sweepCallback.selector, orderId, hash),
            0,
            gasSettings.callbackGas
        );
        callSign.then(callback).transact();
    }
}
```

**Step 2: Delete the old contract**

Delete `smart-contracts/contracts/BitcoinDepositAddressBuilder.sol`.

**Step 3: Verify it compiles**

Run: `cd smart-contracts && yarn build`
Expected: Compilation succeeds (tests will fail until Task 4)

**Step 4: Commit**

```
feat: split BitcoinDepositAddressBuilder into BitcoinDepositAddress manager + builder
```

---

### Task 4: Update Tests

**Files:**
- Modify: `smart-contracts/test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts`

**Step 1: Update the test fixture**

The fixture must deploy both contracts. Key changes:
- Deploy `BitcoinDepositSweepBuilder` with `(owner, depositoryScript, maxFeeRate)` — needs `ChainSignatures` library link
- Deploy `BitcoinDepositAddress` with `(owner, sweepBuilder.address, nearSigner, wNEAR)` — needs `AuroraSdk` and `ChainSignatures` library links
- Return both `manager` and `builder` from the fixture
- Helper function `encodeSweepData(utxo, feeRate)` that returns `abi.encode(utxo, feeRate)` via viem's `encodeAbiParameters`

**Step 2: Update builder tests**

Tests for `buildSweepPayload`, `hashToSign`, `setMaxFeeRate` target the **builder** contract. Changes:
- `buildSweepPayload` calls change from `builder.read.buildSweepPayload([orderId, utxo, feeRate])` to `builder.read.buildSweepPayload([orderId, encodeSweepData(utxo, feeRate)])` and now return a tuple `[payload, sweepAmount]`
- `hashToSign` calls target the builder
- `setMaxFeeRate` calls target the builder
- Contract name in `getContractAt` changes from `"BitcoinDepositAddressBuilder"` to `"BitcoinDepositSweepBuilder"`

**Step 3: Update manager tests**

Tests for `derivationPath` and `sweep` target the **manager** contract. Changes:
- `derivationPath` calls target the manager
- `sweep` test calls change to use `manager.read.buildSweepPayload` → replaced by calling builder directly with encoded data
- Add tests for `setSweepBuilder()`:
  - Owner can call, emits `SweepBuilderChanged`
  - Non-owner reverts with `OwnableUnauthorizedAccount`

**Step 4: Write the updated test file**

The `encodeSweepData` helper uses viem's `encodeAbiParameters` to ABI-encode the `(UTXO, uint64)` tuple. The UTXO struct ABI for encoding:

```typescript
const UTXO_ABI = {
  type: "tuple",
  components: [
    { name: "txid", type: "bytes32" },
    { name: "index", type: "uint32" },
    { name: "value", type: "uint64" },
    { name: "scriptPubKey", type: "bytes" },
  ],
} as const

function encodeSweepData(utxo: { txid: `0x${string}`, index: number, value: bigint, scriptPubKey: `0x${string}` }, feeRate: bigint): `0x${string}` {
  return encodeAbiParameters(
    [UTXO_ABI, { type: "uint64" }],
    [utxo, feeRate]
  )
}
```

For every `builder.read.buildSweepPayload` call, update from 3-arg to 2-arg (with encoded data), and destructure the return as `[payload, sweepAmount]` since it now returns a tuple.

For `builder.read.hashToSign`, no signature change needed (still takes `bytes`).

For `setMaxFeeRate` non-owner test, update contract name from `"BitcoinDepositAddressBuilder"` to `"BitcoinDepositSweepBuilder"`.

Add new `describe("setSweepBuilder()")` block on the manager with:
- Owner can set, emits event
- Non-owner reverts

**Step 5: Run tests**

Run: `cd smart-contracts && yarn test test/BitcoinDepositAddressBuilder/BitcoinDepositAddressBuilder.ts`
Expected: All tests pass

**Step 6: Commit**

```
test: update tests for two-contract BitcoinDepositAddress split
```

---

### Task 5: Update Ignition Module

**Files:**
- Modify: `smart-contracts/ignition/modules/BitcoinDepositAddressBuilder.ts`

**Step 1: Update the ignition module**

Deploy both contracts:
1. `BitcoinDepositSweepBuilder` — params: `owner`, `depositoryScript`, `maxFeeRate`. Library: `ChainSignatures`.
2. `BitcoinDepositAddress` — params: `owner`, `sweepBuilder.address`, `nearSigner`, `wNEAR`. Libraries: `AuroraSdk`, `ChainSignatures`.

```typescript
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

const BitcoinDepositAddressModule = buildModule(
  "BitcoinDepositAddress",
  (m) => {
    const owner = m.getParameter("owner")
    const depositoryScript = m.getParameter("depositoryScript")
    const nearSigner = m.getParameter("nearSigner")
    const wNEAR = m.getParameter("wNEAR")
    const maxFeeRate = m.getParameter("maxFeeRate")

    const ChainSignatures = m.library("ChainSignatures")

    const bitcoinDepositSweepBuilder = m.contract(
      "BitcoinDepositSweepBuilder",
      [owner, depositoryScript, maxFeeRate],
      {
        libraries: {
          ChainSignatures,
        },
      }
    )

    const Codec = m.library("Codec")
    const AuroraXccUtils = m.library("AuroraXccUtils")
    const AuroraSdk = m.library("AuroraSdk", {
      libraries: {
        AuroraXccUtils,
        Codec,
      },
    })

    const bitcoinDepositAddress = m.contract(
      "BitcoinDepositAddress",
      [owner, bitcoinDepositSweepBuilder, nearSigner, wNEAR],
      {
        libraries: {
          AuroraSdk,
          ChainSignatures,
        },
      }
    )

    return { bitcoinDepositSweepBuilder, bitcoinDepositAddress }
  }
)

export default BitcoinDepositAddressModule
```

**Step 2: Verify build**

Run: `cd smart-contracts && yarn build`
Expected: Compilation succeeds

**Step 3: Commit**

```
chore: update ignition module for two-contract deployment
```

---

### Task 6: Lint and Final Verification

**Step 1: Run lint**

Run: `cd smart-contracts && yarn lint`
Expected: No errors. If there are errors, run `yarn lintFix` and review changes.

**Step 2: Run full test suite**

Run: `cd smart-contracts && yarn test`
Expected: All tests pass

**Step 3: Commit any lint fixes**

```
chore: fix lint issues
```
