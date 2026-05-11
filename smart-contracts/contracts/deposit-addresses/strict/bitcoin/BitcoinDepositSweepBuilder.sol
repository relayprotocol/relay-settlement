// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import {ChainSignatures} from "../../../ChainSignatures.sol";
import {Utils} from "../../../Utils.sol";
import {IBitcoinDepositSweepBuilder} from "./IBitcoinDepositSweepBuilder.sol";

/// @notice Bitcoin UTXO structure
struct UTXO {
  bytes32 txid;
  uint32 index;
  uint64 value;
  bytes scriptPubKey;
}

/// @notice Bitcoin transaction input data
struct BitcoinTransactionDataInput {
  bytes txid;
  bytes index;
  bytes script;
  bytes value;
}

/// @notice Bitcoin transaction output data
struct BitcoinTransactionDataOutput {
  bytes value;
  bytes script;
}

/// @notice Complete Bitcoin transaction data
struct BitcoinTransactionData {
  BitcoinTransactionDataInput[] inputs;
  BitcoinTransactionDataOutput[] outputs;
}

/// @title BitcoinDepositSweepBuilder
/// @author Relay Protocol
/// @notice Builds Bitcoin sweep transaction payloads that send deposited funds to a depository
contract BitcoinDepositSweepBuilder is Ownable, IBitcoinDepositSweepBuilder {
  // ── Errors ──────────────────────────────────────────────────────────
  error FeeRateTooHigh(uint64 feeRate, uint64 maxFeeRate);
  error InsufficientUTXOValue(uint64 totalInput, uint256 requiredFees);
  error SweepAmountBelowDust(uint64 sweepAmount);
  error InvalidScriptPubKey();

  // ── Events ──────────────────────────────────────────────────────────

  /// @notice Emitted when the maximum fee rate is changed
  event MaxFeeRateChanged(uint64 maxFeeRate);

  // ── Constants ───────────────────────────────────────────────────────

  /// @dev Minimum UTXO value required by most Bitcoin nodes
  uint64 private constant DUST_THRESHOLD = 546;

  /// @dev Fixed transaction virtual size for single-input P2WPKH sweep (vbytes)
  uint256 private constant SWEEP_TX_SIZE = 191;

  // ── Storage ─────────────────────────────────────────────────────────

  /// @notice Decoded depository P2PKH scriptPubKey
  bytes public depositoryScriptBytes;

  /// @notice Maximum allowed fee rate (sats/vbyte)
  uint64 public maxFeeRate;

  // ── Constructor ─────────────────────────────────────────────────────

  /// @notice Initializes the contract with depository and fee config
  /// @param _owner Contract owner
  /// @param _depositoryScript Base64-encoded P2PKH scriptPubKey of depository
  /// @param _maxFeeRate Maximum allowed fee rate (sats/vbyte)
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
  /// @param _maxFeeRate New maximum fee rate (sats/vbyte)
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

    // Validate P2WPKH scriptPubKey: exactly 22 bytes, starts with 0x0014
    if (
      utxo.scriptPubKey.length != 22 ||
      utxo.scriptPubKey[0] != 0x00 ||
      utxo.scriptPubKey[1] != 0x14
    ) {
      revert InvalidScriptPubKey();
    }

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

  // ── Internal Functions (BIP143 sighash) ────────────────────────────

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

  /// @notice Builds BIP143 SIGHASH_ALL preimage for a P2WPKH input
  /// @param txData The complete transaction data
  /// @param whichInput Index of the input to build preimage for
  /// @return The BIP143 preimage bytes for signing
  function buildPreImageForInput(
    BitcoinTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes memory) {
    BitcoinTransactionDataInput memory input = txData.inputs[whichInput];

    // outpoint = txid || index of the input being signed
    bytes memory outpoint = bytes.concat(input.txid, input.index);

    // scriptCode for P2WPKH: 0x19 76 a9 14 <20-byte-hash> 88 ac
    // Extract the 20-byte pubkey hash from the witness program (bytes 2..22 of scriptPubKey)
    bytes memory scriptCode = _buildScriptCode(input.script);

    // Split into two halves to avoid stack-too-deep
    bytes memory firstHalf = bytes.concat(
      Utils.encodeUint32LE(1), // nVersion
      _hashPrevouts(txData.inputs),
      _hashSequence(txData.inputs),
      outpoint,
      scriptCode
    );

    return
      bytes.concat(
        firstHalf,
        input.value, // value of the input being signed (8 bytes LE)
        Utils.encodeUint32LE(0xFFFFFFFD), // nSequence
        _hashOutputs(txData.outputs),
        Utils.encodeUint32LE(0), // nLocktime
        Utils.encodeUint32LE(0x01) // nHashType (SIGHASH_ALL)
      );
  }

  /// @notice Computes SHA256d of all outpoints for BIP143 hashPrevouts
  /// @return The double-SHA256 hash of all outpoints
  function _hashPrevouts(
    BitcoinTransactionDataInput[] memory inputs
  ) private pure returns (bytes32) {
    bytes memory allOutpoints;
    for (uint256 i = 0; i < inputs.length; i++) {
      allOutpoints = bytes.concat(
        allOutpoints,
        inputs[i].txid,
        inputs[i].index
      );
    }
    return sha256(abi.encodePacked(sha256(allOutpoints)));
  }

  /// @notice Computes SHA256d of all sequences for BIP143 hashSequence
  /// @return The double-SHA256 hash of all sequences
  function _hashSequence(
    BitcoinTransactionDataInput[] memory inputs
  ) private pure returns (bytes32) {
    bytes memory allSequences;
    for (uint256 i = 0; i < inputs.length; i++) {
      allSequences = bytes.concat(
        allSequences,
        Utils.encodeUint32LE(0xFFFFFFFD)
      );
    }
    return sha256(abi.encodePacked(sha256(allSequences)));
  }

  /// @notice Computes SHA256d of all serialized outputs for BIP143 hashOutputs
  /// @return The double-SHA256 hash of all serialized outputs
  function _hashOutputs(
    BitcoinTransactionDataOutput[] memory outputs
  ) private pure returns (bytes32) {
    bytes memory allOutputs;
    for (uint256 j = 0; j < outputs.length; j++) {
      bytes memory scriptPubKey = outputs[j].script;
      allOutputs = bytes.concat(
        allOutputs,
        outputs[j].value,
        encodeVarInt(scriptPubKey.length),
        scriptPubKey
      );
    }
    return sha256(abi.encodePacked(sha256(allOutputs)));
  }

  /// @notice Builds P2WPKH scriptCode from witness program
  /// @return The BIP143 scriptCode bytes
  function _buildScriptCode(
    bytes memory witnessProgram
  ) private pure returns (bytes memory) {
    bytes memory pubkeyHash = new bytes(20);
    for (uint256 i = 0; i < 20; i++) {
      pubkeyHash[i] = witnessProgram[i + 2];
    }
    return abi.encodePacked(hex"1976a914", pubkeyHash, hex"88ac");
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
