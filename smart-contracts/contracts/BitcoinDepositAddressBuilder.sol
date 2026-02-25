// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import {
  AuroraSdk,
  NEAR,
  PromiseCreateArgs,
  PromiseResult,
  PromiseResultStatus,
  PromiseWithCallback
} from "./aurora-xcc/AuroraSdk.sol";
import {ChainSignatures} from "./ChainSignatures.sol";
import {Utils} from "./Utils.sol";
import {
  UTXO,
  BitcoinTransactionDataInput,
  BitcoinTransactionDataOutput,
  BitcoinTransactionData
} from "./PayloadBuilders/BitcoinPayloadBuilder.sol";
import {GasSettings} from "./RelayAllocator.sol";

/// @title BitcoinDepositAddressBuilder
/// @author Relay Protocol
/// @notice Generates deterministic Bitcoin deposit addresses via NEAR MPC path derivation,
/// builds sweep transactions that send deposited funds to a depository, and handles MPC signing.
contract BitcoinDepositAddressBuilder is Ownable {
  using AuroraSdk for NEAR;
  using AuroraSdk for PromiseCreateArgs;
  using AuroraSdk for PromiseWithCallback;
  using AuroraSdk for PromiseResult;

  // ── Errors ──────────────────────────────────────────────────────────
  error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
  error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
  error SweepAmountBelowDust(uint64 sweepAmount);
  error SignatureAlreadyComplete(bytes32 orderId, bytes32 hashToSign);
  error SignaturePending(bytes32 orderId, uint256 expiration);
  error SignCallbackFailed(bytes32 orderId);

  // ── Events ──────────────────────────────────────────────────────────

  /// @notice Emitted when the maximum fee rate is changed
  event MaxFeeRateChanged(uint64 maxFeeRate);
  /// @notice Emitted when a sweep payload is submitted
  event SweepSubmitted(
    bytes32 indexed orderId,
    bytes payload,
    uint64 sweepAmount
  );
  /// @notice Emitted when a sweep payload is signed by the MPC
  event SweepSigned(
    bytes32 indexed orderId,
    bytes32 indexed hashToSign,
    bytes signature
  );

  // ── Constants ───────────────────────────────────────────────────────

  /// @dev Minimum UTXO value required by most Bitcoin nodes
  uint64 private constant DUST_THRESHOLD = 546;

  /// @dev Fixed transaction size for single-input sweep: 148 (input) + 121 (outputs + overhead)
  uint256 private constant SWEEP_TX_SIZE = 269;

  /// @dev Cooldown period for pending MPC signature requests
  uint256 private constant PENDING_SIGNATURE_COOLDOWN = 5 minutes;

  // ── Storage ─────────────────────────────────────────────────────────

  /// @notice Decoded depository P2PKH scriptPubKey
  bytes public depositoryScriptBytes;

  /// @notice NEAR MPC signer account
  string public nearSigner;

  /// @notice Aurora SDK instance
  NEAR public near;

  /// @notice Maximum allowed fee rate (sats/byte)
  uint64 public maxFeeRate;

  /// @notice orderId → hashToSign → encoded sweep payload
  mapping(bytes32 => mapping(bytes32 => bytes)) public sweepPayloads;

  /// @notice orderId → hashToSign → signature
  mapping(bytes32 => mapping(bytes32 => bytes)) public signedPayloads;

  /// @notice orderId → hashToSign → expiration timestamp
  mapping(bytes32 => mapping(bytes32 => uint256)) public pendingSignatures;

  // ── Constructor ─────────────────────────────────────────────────────

  /// @notice Initializes the contract with depository, signer, and fee config
  /// @param _owner Contract owner
  /// @param _depositoryScript Base64-encoded P2PKH scriptPubKey of depository
  /// @param _nearSigner NEAR MPC signer account
  /// @param _wNEAR Wrapped NEAR token address
  /// @param _maxFeeRate Maximum allowed fee rate (sats/byte)
  constructor(
    address _owner,
    string memory _depositoryScript,
    string memory _nearSigner,
    address _wNEAR,
    uint64 _maxFeeRate
  ) Ownable(_owner) {
    depositoryScriptBytes = Base64.decode(_depositoryScript);
    nearSigner = _nearSigner;
    near = AuroraSdk.initNear(IERC20(_wNEAR));
    maxFeeRate = _maxFeeRate;
  }

  // ── External / Public Functions ─────────────────────────────────────

  /// @notice Bootstrap XCC sub-account on NEAR (costs 2 wNEAR)
  function init() external onlyOwner {
    near.wNEAR.transferFrom(
      msg.sender,
      address(this),
      uint256(2_000_000_000_000_000_000_000_000)
    );

    PromiseCreateArgs memory initCall = near.call(
      "system",
      "",
      "",
      0,
      500_000_000_000
    );
    initCall.transact();
  }

  /// @notice Updates the maximum allowed fee rate
  /// @param _maxFeeRate New maximum fee rate (sats/byte)
  function setMaxFeeRate(uint64 _maxFeeRate) external onlyOwner {
    maxFeeRate = _maxFeeRate;
    emit MaxFeeRateChanged(_maxFeeRate);
  }

  /// @notice Returns the NEAR MPC derivation path for a given order
  /// @param orderId The 32-byte order identifier
  /// @return The derivation path: hex(address(this)) + "/" + hex(orderId)
  function derivationPath(bytes32 orderId) public view returns (string memory) {
    return
      string.concat(
        Strings.toHexString(uint160(address(this)), 20),
        "/",
        ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
      );
  }

  /// @notice Builds the sweep transaction payload for a single UTXO
  /// @param orderId The 32-byte order identifier (used for OP_RETURN)
  /// @param utxo The single deposit UTXO to sweep
  /// @param feeRate Fee rate in satoshis per byte
  /// @return ABI-encoded BitcoinTransactionData
  function buildSweepPayload(
    bytes32 orderId,
    UTXO calldata utxo,
    uint64 feeRate
  ) public view returns (bytes memory) {
    if (feeRate > maxFeeRate) {
      revert FeeRateTooHigh(feeRate, maxFeeRate);
    }

    uint256 fees = uint256(feeRate) * SWEEP_TX_SIZE;
    if (utxo.value < fees) {
      revert InsufficientUTXOValue(utxo.value, fees);
    }

    uint64 sweepAmount = utxo.value - uint64(fees);
    if (sweepAmount < DUST_THRESHOLD) {
      revert SweepAmountBelowDust(sweepAmount);
    }

    // Build the single input
    BitcoinTransactionDataInput[]
      memory inputs = new BitcoinTransactionDataInput[](1);
    inputs[0] = buildInput(utxo);

    // Build 2 outputs: depository + OP_RETURN
    BitcoinTransactionDataOutput[]
      memory outputs = new BitcoinTransactionDataOutput[](2);

    // Output 0: Depository (P2PKH)
    outputs[0] = BitcoinTransactionDataOutput({
      value: Utils.encodeUint64LE(sweepAmount),
      script: depositoryScriptBytes
    });

    // Output 1: OP_RETURN with orderId as hex string
    // 0x6a = OP_RETURN, 0x42 = PUSH 66 bytes, then "0x" + hex(orderId)
    outputs[1] = BitcoinTransactionDataOutput({
      value: Utils.encodeUint64LE(0),
      script: abi.encodePacked(
        hex"6a42",
        "0x",
        ChainSignatures.stringifyBytes(abi.encodePacked(orderId))
      )
    });

    return
      abi.encode(BitcoinTransactionData({inputs: inputs, outputs: outputs}));
  }

  /// @notice Combined submit-and-sign: builds payload, stores it, computes hash, calls NEAR MPC.
  /// @dev Permissionless — anyone can call. Re-callable after the pending signature cooldown
  /// expires to prevent griefing via low gas settings.
  /// @param orderId The 32-byte order identifier
  /// @param utxo The single deposit UTXO to sweep
  /// @param feeRate Fee rate in satoshis per byte
  /// @param gasSettings Gas settings for NEAR MPC call
  function sweep(
    bytes32 orderId,
    UTXO calldata utxo,
    uint64 feeRate,
    GasSettings calldata gasSettings
  ) external {
    // Build the payload and compute its hash
    bytes memory payload = buildSweepPayload(orderId, utxo, feeRate);
    bytes32 hash = hashToSign(payload);

    // Store payload keyed by (orderId, hash) to preserve all payloads
    sweepPayloads[orderId][hash] = payload;

    // Compute the sweep amount for the event
    uint256 fees = uint256(feeRate) * SWEEP_TX_SIZE;
    uint64 sweepAmount = utxo.value - uint64(fees);

    emit SweepSubmitted(orderId, payload, sweepAmount);

    // Request MPC signature
    _requestSignature(orderId, hash, gasSettings);
  }

  /// @notice Validates signature state and sends the signing request to NEAR MPC
  function _requestSignature(
    bytes32 orderId,
    bytes32 hash,
    GasSettings calldata gasSettings
  ) internal {
    // Check signature state
    if (signedPayloads[orderId][hash].length > 0) {
      revert SignatureAlreadyComplete(orderId, hash);
    }

    uint256 expiration = pendingSignatures[orderId][hash];
    if (block.timestamp < expiration) {
      revert SignaturePending(orderId, expiration);
    }

    pendingSignatures[orderId][hash] =
      block.timestamp + PENDING_SIGNATURE_COOLDOWN;

    // Compute per-order derivation path
    string memory path = derivationPath(orderId);

    // Encode JSON request for NEAR MPC
    bytes memory data = ChainSignatures.encodeJSONRequest(
      ChainSignatures.stringifyBytes(abi.encodePacked(hash)),
      "Ecdsa",
      path,
      "0"
    );

    // Call NEAR MPC to sign
    PromiseCreateArgs memory callSign = near.call(
      nearSigner,
      "sign",
      data,
      1, // 1 yoctoNEAR
      gasSettings.signGas
    );
    PromiseCreateArgs memory callback = near.auroraCall(
      address(this),
      abi.encodeWithSelector(this.sweepCallback.selector, orderId, hash),
      0,
      gasSettings.callbackGas
    );
    callSign.then(callback).transact();
  }

  /// @notice NEAR callback — stores the resulting signature
  /// @param orderId The order identifier
  /// @param _hashToSign The hash that was signed
  function sweepCallback(bytes32 orderId, bytes32 _hashToSign) external {
    if (
      msg.sender != AuroraSdk.nearRepresentitiveImplicitAddress(address(this))
    ) {
      revert SignCallbackFailed(orderId);
    }

    PromiseResult memory result = AuroraSdk.promiseResult(0);

    if (result.status != PromiseResultStatus.Successful) {
      revert SignCallbackFailed(orderId);
    }

    signedPayloads[orderId][_hashToSign] = result.output;
    emit SweepSigned(orderId, _hashToSign, result.output);
  }

  /// @notice Returns double-SHA256 of the SIGHASH_ALL preimage for the single input
  /// @param payload ABI-encoded BitcoinTransactionData
  /// @return The hash to sign
  function hashToSign(bytes memory payload) public pure returns (bytes32) {
    BitcoinTransactionData memory txData = abi.decode(
      payload,
      (BitcoinTransactionData)
    );

    bytes memory pre = buildPreImageForInput(txData, 0);
    return sha256(abi.encodePacked(sha256(pre)));
  }

  // ── Internal Functions (duplicated from BitcoinPayloadBuilder) ──────

  /// @notice Converts a single UTXO to a transaction input
  /// @param utxo The UTXO to convert
  /// @return The formatted transaction input
  function buildInput(
    UTXO memory utxo
  ) internal pure returns (BitcoinTransactionDataInput memory) {
    return
      BitcoinTransactionDataInput({
        txid: abi.encodePacked(utxo.txid),
        index: Utils.encodeUint32LE(utxo.index),
        script: utxo.scriptPubKey,
        value: Utils.encodeUint64LE(utxo.value)
      });
  }

  /// @notice Builds SIGHASH_ALL preimage for a specific input
  /// @param txData The complete transaction data
  /// @param whichInput Index of the input to build preimage for
  /// @return The preimage bytes for signing
  function buildPreImageForInput(
    BitcoinTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes memory) {
    bytes memory versionLE = Utils.encodeUint32LE(1);

    uint256 numInputs = txData.inputs.length;
    bytes memory inputCountLE = encodeVarInt(numInputs);

    bytes memory allInputs;
    for (uint256 i = 0; i < numInputs; i++) {
      bytes memory prevTxidLe = txData.inputs[i].txid;
      bytes memory prevIndexLe = txData.inputs[i].index;

      bytes memory scriptSigLen;
      bytes memory scriptSigBytes;
      if (i == whichInput) {
        scriptSigBytes = txData.inputs[i].script;
        scriptSigLen = encodeVarInt(scriptSigBytes.length);
      } else {
        scriptSigLen = hex"00";
        scriptSigBytes = "";
      }

      bytes memory sequenceLE = Utils.encodeUint32LE(0xFFFFFFFD);

      allInputs = bytes.concat(
        allInputs,
        prevTxidLe,
        prevIndexLe,
        scriptSigLen,
        scriptSigBytes,
        sequenceLE
      );
    }

    uint256 numOutputs = txData.outputs.length;
    bytes memory outputCountLE = encodeVarInt(numOutputs);

    bytes memory allOutputs;
    for (uint256 j = 0; j < numOutputs; j++) {
      bytes memory valueLE = txData.outputs[j].value;
      bytes memory scriptPubKey = txData.outputs[j].script;
      bytes memory scriptLenLE = encodeVarInt(scriptPubKey.length);

      allOutputs = bytes.concat(allOutputs, valueLE, scriptLenLE, scriptPubKey);
    }

    bytes memory locktimeLE = Utils.encodeUint32LE(0);
    bytes memory hashTypeLE = Utils.encodeUint32LE(0x01);

    return
      bytes.concat(
        versionLE,
        inputCountLE,
        allInputs,
        outputCountLE,
        allOutputs,
        locktimeLE,
        hashTypeLE
      );
  }

  /// @notice Encodes Bitcoin CompactSize varint
  /// @param value The value to encode
  /// @return The encoded varint bytes
  function encodeVarInt(uint256 value) internal pure returns (bytes memory) {
    if (value < 0xFD) {
      return abi.encodePacked(uint8(value));
    } else if (value <= 0xFFFF) {
      return
        abi.encodePacked(
          hex"FD",
          bytes1(uint8(value & 0xFF)),
          bytes1(uint8((value >> 8) & 0xFF))
        );
    } else if (value <= 0xFFFFFFFF) {
      return
        abi.encodePacked(
          hex"FE",
          bytes1(uint8(value & 0xFF)),
          bytes1(uint8((value >> 8) & 0xFF)),
          bytes1(uint8((value >> 16) & 0xFF)),
          bytes1(uint8((value >> 24) & 0xFF))
        );
    } else {
      return
        abi.encodePacked(
          hex"FF",
          bytes1(uint8(value & 0xFF)),
          bytes1(uint8((value >> 8) & 0xFF)),
          bytes1(uint8((value >> 16) & 0xFF)),
          bytes1(uint8((value >> 24) & 0xFF)),
          bytes1(uint8((value >> 32) & 0xFF)),
          bytes1(uint8((value >> 40) & 0xFF)),
          bytes1(uint8((value >> 48) & 0xFF)),
          bytes1(uint8((value >> 56) & 0xFF))
        );
    }
  }
}
