// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";
import {Base64} from "solady/src/utils/Base64.sol";
import "../Utils.sol";

struct BitcoinTransactionParams {
  UTXO[] utxos; // Array of UTXOs to spend
  uint64 feeRate; // Fee rate in satoshis per byte
}

struct UTXO {
  bytes32 txid; // Transaction ID in little-endian format (reversed from display)
  uint32 index;
  uint64 value;
  bytes scriptPubKey;
}

struct BitcoinTransactionDataInput {
  bytes txid;
  bytes index;
  bytes script;
  bytes value;
}

struct BitcoinTransactionDataOutput {
  bytes value;
  bytes script;
}

struct BitcoinTransactionData {
  BitcoinTransactionDataInput[] inputs;
  BitcoinTransactionDataOutput[] outputs;
}

/// @title BitcoinPayloadBuilder
/// @notice Builds Bitcoin transaction payloads for cross-chain withdrawals
contract BitcoinPayloadBuilder is PayloadBuilder {
  error InsufficientUTXOValue(uint64 totalInput, uint256 requiredAmount);
  error FeesTooHigh(uint64 amount, uint256 fees);
  bytes public changeScriptBytes;

  /// @notice Constructor that initializes the payload builder with a change script.
  /// @param changeScript Base64 encoded scriptPubKey for the change output. It can be generated with bitcoinjs for a specific address.  We do not pass base58 addresses because handling base58 in solidity is actually pretty expensive (gas) and we don't really need to build these onchain anyway.
  constructor(string memory changeScript) {
    changeScriptBytes = Base64.decode(changeScript);
  }

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

  /// This builds a payload for a Bitcoin transaction
  /// @notice The payload is a BitcoinTransactionData struct that contains the inputs and outputs. It is _not_ a Bitcoin "raw" transaction.
  /// But an object that can be used to build Bitcoin transactions offchain, when combined with the signatures
  /// @param amount The amount to send
  /// @param receiverScript The scriptPubKey of the receiver
  /// @param data The UTXOs to spend
  function buildPayload(
    uint256 /* chainId */,
    string memory /* depository */,
    string memory /* currency */,
    uint256 amount,
    string memory receiverScript, // Base64 encoded scriptPubKey
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

  /// @dev Build the “legacy” SIGHASH_ALL preimage for input #whichInput.
  function buildPreImageForInput(
    BitcoinTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes memory) {
    // --- 1) version (little‐endian 0x00000001) ---
    bytes memory versionLE = Utils.encodeUint32LE(1);

    // --- 2) varint(inputCount) ---
    uint256 nInputs = txData.inputs.length;
    bytes memory inputCountLE = encodeVarInt(nInputs);

    // --- 3) serialize all inputs, but only input #whichInput gets its scriptPubKey as "scriptSig" ---
    bytes memory allInputs;
    for (uint256 i = 0; i < nInputs; i++) {
      // a) txid is already reversed in buildInputs → use as‐is (32 bytes)
      bytes memory prevTxid_LE = txData.inputs[i].txid; // 32 bytes
      // b) output index (4 bytes LE)
      bytes memory prevIndex_LE = txData.inputs[i].index; // 4 bytes
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
      //    [ prevTxid_LE || prevIndex_LE || scriptSigLen || scriptSigBytes || sequenceLE ]
      allInputs = bytes.concat(
        allInputs,
        prevTxid_LE,
        prevIndex_LE,
        scriptSigLen,
        scriptSigBytes,
        sequenceLE
      );
    }

    // --- 4) varint(outputCount) ---
    uint256 nOutputs = txData.outputs.length;
    bytes memory outputCountLE = encodeVarInt(nOutputs);

    // --- 5) serialize all outputs: each is [ valueLE (8b) || varint(scriptLen) || scriptBytes ] ---
    bytes memory allOutputs;
    for (uint256 j = 0; j < nOutputs; j++) {
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

  ///  @notice Given the ABI-encoded `BitcoinTransactionData`, produce one double-SHA256 digest per input.
  /// @param payload The ABI-encoded `BitcoinTransactionData`
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

  // This is used by Near to identify the curve used for signing
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  function family() external pure returns (string memory) {
    return "bitcoin-vm";
  }

  // Util functions for encoding Bitcoin transaction data

  /// @dev Encode a “CompactSize” varint (as in Bitcoin, for script‐lengths or array‐lengths).
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
