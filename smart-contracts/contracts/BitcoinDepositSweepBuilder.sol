// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import {ChainSignatures} from "./ChainSignatures.sol";
import {Utils} from "./Utils.sol";
import {
  UTXO,
  BitcoinTransactionDataInput,
  BitcoinTransactionDataOutput,
  BitcoinTransactionData
} from "./PayloadBuilders/BitcoinPayloadBuilder.sol";
import {IBitcoinDepositSweepBuilder} from "./interfaces/IBitcoinDepositSweepBuilder.sol";

/// @title BitcoinDepositSweepBuilder
/// @author Relay Protocol
/// @notice Builds Bitcoin sweep transaction payloads that send deposited funds to a depository
contract BitcoinDepositSweepBuilder is Ownable, IBitcoinDepositSweepBuilder {
  // ── Errors ──────────────────────────────────────────────────────────
  error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
  error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
  error SweepAmountBelowDust(uint64 sweepAmount);

  // ── Events ──────────────────────────────────────────────────────────

  /// @notice Emitted when the maximum fee rate is changed
  event MaxFeeRateChanged(uint64 maxFeeRate);

  // ── Constants ───────────────────────────────────────────────────────

  /// @dev Minimum UTXO value required by most Bitcoin nodes
  uint64 private constant DUST_THRESHOLD = 546;

  /// @dev Fixed transaction size for single-input sweep: 148 (input) + 121 (outputs + overhead)
  uint256 private constant SWEEP_TX_SIZE = 269;

  // ── Storage ─────────────────────────────────────────────────────────

  /// @notice Decoded depository P2PKH scriptPubKey
  bytes public depositoryScriptBytes;

  /// @notice Maximum allowed fee rate (sats/byte)
  uint64 public maxFeeRate;

  // ── Constructor ─────────────────────────────────────────────────────

  /// @notice Initializes the contract with depository and fee config
  /// @param _owner Contract owner
  /// @param _depositoryScript Base64-encoded P2PKH scriptPubKey of depository
  /// @param _maxFeeRate Maximum allowed fee rate (sats/byte)
  constructor(
    address _owner,
    string memory _depositoryScript,
    uint64 _maxFeeRate
  ) Ownable(_owner) {
    depositoryScriptBytes = Base64.decode(_depositoryScript);
    maxFeeRate = _maxFeeRate;
  }

  // ── External / Public Functions ─────────────────────────────────────

  /// @notice Updates the maximum allowed fee rate
  /// @param _maxFeeRate New maximum fee rate (sats/byte)
  function setMaxFeeRate(uint64 _maxFeeRate) external onlyOwner {
    maxFeeRate = _maxFeeRate;
    emit MaxFeeRateChanged(_maxFeeRate);
  }

  /// @notice Builds the sweep transaction payload from opaque data
  /// @param orderId The 32-byte order identifier (used for OP_RETURN)
  /// @param data ABI-encoded (UTXO, uint64 feeRate)
  /// @return payload ABI-encoded BitcoinTransactionData
  /// @return sweepAmount The amount being swept to the depository
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

    payload = abi.encode(
      BitcoinTransactionData({inputs: inputs, outputs: outputs})
    );
  }

  /// @notice Returns double-SHA256 of the SIGHASH_ALL preimage for the single input
  /// @param payload ABI-encoded BitcoinTransactionData
  /// @return The hash to sign
  function hashToSign(bytes calldata payload) external pure returns (bytes32) {
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
