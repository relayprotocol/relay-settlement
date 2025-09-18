// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../Allocator.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import "../Utils.sol";

/// @notice Bitcoin transaction parameters
struct BitcoinTransactionParams {
  UTXO[] utxos; /// @notice UTXOs to spend
  uint64 feeRate; /// @notice Fee rate in satoshis per byte
}

/// @notice Bitcoin UTXO structure
struct UTXO {
  bytes32 txid; /// @notice Transaction ID in little-endian format
  uint32 index; /// @notice Output index
  uint64 value; /// @notice UTXO value in satoshis
  bytes scriptPubKey; /// @notice Output script
}

/// @notice Bitcoin transaction input data
struct BitcoinTransactionDataInput {
  bytes txid; /// @notice Transaction ID bytes
  bytes index; /// @notice Output index bytes
  bytes script; /// @notice Script bytes
  bytes value; /// @notice Value bytes
}

/// @notice Bitcoin transaction output data
struct BitcoinTransactionDataOutput {
  bytes value; /// @notice Output value bytes
  bytes script; /// @notice Output script bytes
}

/// @notice Complete Bitcoin transaction data
struct BitcoinTransactionData {
  BitcoinTransactionDataInput[] inputs; /// @notice Transaction inputs
  BitcoinTransactionDataOutput[] outputs; /// @notice Transaction outputs
}

/// @title BitcoinPayloadBuilder
/// @author Relay Protocol
/// @notice Builds Bitcoin transaction payloads for cross-chain withdrawals
contract BitcoinPayloadBuilder is IPayloadBuilder {
  error InsufficientUTXOValue(uint64 totalInput, uint256 requiredAmount);
  error FeesTooHigh(uint64 amount, uint256 fees);
  /// @notice The change script bytes for Bitcoin transactions
  bytes public changeScriptBytes;

  /// @notice Initializes Bitcoin payload builder with change script
  /// @param changeScript Base64 encoded scriptPubKey for change output
  constructor(string memory changeScript) {
    changeScriptBytes = Base64.decode(changeScript);
  }

  /// @notice Validates UTXO amounts and calculates change
  /// @param amount Required amount to send
  /// @param utxos Available UTXOs
  /// @return change Amount to return as change
  function validateAmounts(
    uint256 amount,
    UTXO[] memory utxos
  ) internal pure returns (uint64 change) {
    uint64 totalInput = 0;
    for (uint256 i = 0; i < utxos.length; i++) {
      totalInput += utxos[i].value;
    }
    if (totalInput < amount) {
      revert InsufficientUTXOValue(totalInput, amount);
    }

    // Keep track of change to create additional UTXO if needed
    change = totalInput - uint64(amount);
  }

  /// @notice Builds transaction inputs from UTXOs
  /// @param utxos UTXOs to convert to inputs
  /// @return inputs Formatted transaction inputs
  function buildInputs(
    UTXO[] memory utxos
  ) internal pure returns (BitcoinTransactionDataInput[] memory inputs) {
    inputs = new BitcoinTransactionDataInput[](utxos.length);

    for (uint256 i = 0; i < utxos.length; i++) {
      bytes memory script = utxos[i].scriptPubKey;
      inputs[i] = BitcoinTransactionDataInput({
        txid: abi.encodePacked(utxos[i].txid), // txid already in little-endian from txidToBytes32
        index: Utils.encodeUint32LE(utxos[i].index), // index of the output
        script: script,
        value: Utils.encodeUint64LE(utxos[i].value) // value of the output
      });
    }
  }

  /// @notice Builds transaction outputs including change
  /// @param receiverScript Base64 encoded receiver scriptPubKey
  /// @param amount Amount to send to receiver
  /// @param change Amount to return as change
  /// @param inputsLength Number of inputs for fee calculation
  /// @param feeRate Fee rate in satoshis per byte
  /// @return outputs Formatted transaction outputs
  function buildOutputs(
    string memory receiverScript,
    uint64 amount,
    uint64 change,
    uint256 inputsLength,
    uint64 feeRate
  ) internal view returns (BitcoinTransactionDataOutput[] memory outputs) {
    outputs = new BitcoinTransactionDataOutput[](change > 0 ? 2 : 1);

    // Calculate the fees
    uint256 fees = feeRate * (inputsLength * 148 + outputs.length * 34 + 10);
    if (amount < fees) {
      revert FeesTooHigh(amount, fees);
    }
    // Output 1: to receiver
    bytes memory receiverScriptBytes = Base64.decode(receiverScript);
    outputs[0] = BitcoinTransactionDataOutput({
      value: Utils.encodeUint64LE(amount - uint64(fees)),
      script: receiverScriptBytes
    });

    // Output 2: to self for change (if needed)
    if (change > 0) {
      outputs[1] = BitcoinTransactionDataOutput({
        value: Utils.encodeUint64LE(change),
        script: changeScriptBytes
      });
    }
  }

  /// @notice Builds Bitcoin transaction payload
  /// @dev Returns BitcoinTransactionData struct, not a _raw_ transaction
  /// @param amount Amount to send in satoshis
  /// @param receiverScript Base64 encoded receiver scriptPubKey
  /// @param data Encoded BitcoinTransactionParams
  /// @return Encoded BitcoinTransactionData
  function buildPayload(
    uint256 /* chainId */,
    string memory /* depository */,
    string memory /* currency */,
    uint256 amount,
    string memory receiverScript,
    bytes calldata data
  ) external view override returns (bytes memory) {
    BitcoinTransactionParams memory params = abi.decode(
      data,
      (BitcoinTransactionParams)
    );

    // Check that the amount from the UTXOs is sufficient
    uint64 change = validateAmounts(amount, params.utxos);

    // Build the inputs
    BitcoinTransactionDataInput[] memory inputs = buildInputs(params.utxos);

    // Build the outputs
    BitcoinTransactionDataOutput[] memory outputs = buildOutputs(
      receiverScript,
      uint64(amount),
      change,
      inputs.length,
      params.feeRate
    );

    return
      abi.encode(BitcoinTransactionData({inputs: inputs, outputs: outputs}));
  }

  /// @notice Builds SIGHASH_ALL preimage for specific input
  /// @param txData Complete transaction data
  /// @param whichInput Index of input to build preimage for
  /// @return Preimage bytes for signing
  function buildPreImageForInput(
    BitcoinTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes memory) {
    // --- 1) version (little‐endian 0x00000001) ---
    bytes memory versionLE = Utils.encodeUint32LE(1);

    // --- 2) varint(inputCount) ---
    uint256 numInputs = txData.inputs.length;
    bytes memory inputCountLE = encodeVarInt(numInputs);

    // --- 3) serialize all inputs, but only input #whichInput gets its scriptPubKey as "scriptSig" ---
    bytes memory allInputs;
    for (uint256 i = 0; i < numInputs; i++) {
      // a) txid is already reversed in buildInputs → use as‐is (32 bytes)
      bytes memory prevTxidLe = txData.inputs[i].txid; // 32 bytes
      // b) output index (4 bytes LE)
      bytes memory prevIndexLe = txData.inputs[i].index; // 4 bytes
      // c) scriptSig length + scriptSig bytes
      bytes memory scriptSigLen;
      bytes memory scriptSigBytes;
      if (i == whichInput) {
        // Insert the UTXO’s scriptPubKey
        scriptSigBytes = txData.inputs[i].script;
        scriptSigLen = encodeVarInt(scriptSigBytes.length);
      } else {
        // empty script
        scriptSigLen = hex"00";
        scriptSigBytes = "";
      }
      // d) sequence = 0xFFFFFFFF (4 bytes LE)
      bytes memory sequenceLE = Utils.encodeUint32LE(0xFFFFFFFF);

      // e) concat this input's fields:
      //    [ prevTxidLe || prevIndexLe || scriptSigLen || scriptSigBytes || sequenceLE ]
      allInputs = bytes.concat(
        allInputs,
        prevTxidLe,
        prevIndexLe,
        scriptSigLen,
        scriptSigBytes,
        sequenceLE
      );
    }

    // --- 4) varint(outputCount) ---
    uint256 numOutputs = txData.outputs.length;
    bytes memory outputCountLE = encodeVarInt(numOutputs);

    // --- 5) serialize all outputs: each is [ valueLE (8b) || varint(scriptLen) || scriptBytes ] ---
    bytes memory allOutputs;
    for (uint256 j = 0; j < numOutputs; j++) {
      // a) 8‐byte LE value
      bytes memory valueLE = txData.outputs[j].value; // your encodeUint64LE already returned 8‐byte LE

      // b) varint(script length)
      bytes memory scriptPubKey = txData.outputs[j].script;
      bytes memory scriptLenLE = encodeVarInt(scriptPubKey.length);

      // c) concat → [ valueLE || scriptLenLE || scriptPubKey ]
      allOutputs = bytes.concat(allOutputs, valueLE, scriptLenLE, scriptPubKey);
    }

    // --- 6) locktime (4 bytes LE = 0) and hashType (4 bytes LE = 0x01_00_00_00 for SIGHASH_ALL) ---
    bytes memory locktimeLE = Utils.encodeUint32LE(0);
    bytes memory hashTypeLE = Utils.encodeUint32LE(0x01);

    // --- 7) Full preimage: [ versionLE || inputCountLE || allInputs || outputCountLE || allOutputs || locktimeLE || hashTypeLE ] ---
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

  /// @notice Returns message hashes to sign for Bitcoin transaction
  /// @param payload Encoded BitcoinTransactionData
  /// @return Array of double-SHA256 hashes to sign
  function hashesToSign(
    uint256, // chainId (ignored)
    string memory, // depository (ignored)
    bytes calldata payload
  ) external pure override returns (bytes32[] memory) {
    // 1) Decode the struct you packed in buildPayload(...)
    BitcoinTransactionData memory txData = abi.decode(
      payload,
      (BitcoinTransactionData)
    );

    uint256 n = txData.inputs.length;
    bytes32[] memory digests = new bytes32[](n);

    // 2) For each input, build its legacy preimage and double-SHA256 it
    for (uint256 i = 0; i < n; i++) {
      bytes memory pre = buildPreImageForInput(txData, i);
      // double SHA-256:
      bytes32 h2 = sha256(abi.encodePacked(sha256(pre)));
      digests[i] = h2;
    }

    return digests;
  }

  /// @notice Returns cryptographic curve for Bitcoin signing
  /// @return curve "Ecdsa" for Bitcoin
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  /// @notice Returns blockchain family identifier
  /// @return family "bitcoin-vm" for Bitcoin
  function family() external pure returns (string memory) {
    return "bitcoin-vm";
  }

  /// @notice Encodes Bitcoin CompactSize varint
  /// @param value Value to encode
  /// @return Encoded varint bytes
  function encodeVarInt(uint256 value) internal pure returns (bytes memory) {
    if (value < 0xFD) {
      // 1 byte
      return abi.encodePacked(uint8(value));
    } else if (value <= 0xFFFF) {
      // 0xFD + uint16 little‐endian
      return
        abi.encodePacked(
          hex"FD",
          bytes1(uint8(value & 0xFF)),
          bytes1(uint8((value >> 8) & 0xFF))
        );
    } else if (value <= 0xFFFFFFFF) {
      // 0xFE + uint32 little‐endian
      return
        abi.encodePacked(
          hex"FE",
          bytes1(uint8(value & 0xFF)),
          bytes1(uint8((value >> 8) & 0xFF)),
          bytes1(uint8((value >> 16) & 0xFF)),
          bytes1(uint8((value >> 24) & 0xFF))
        );
    } else {
      // 0xFF + uint64 little‐endian
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
