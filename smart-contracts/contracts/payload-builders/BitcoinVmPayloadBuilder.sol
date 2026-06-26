// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @notice Bitcoin UTXO structure.
struct BitcoinVmUtxo {
  bytes32 txid; /// @notice Transaction ID in little-endian format
  uint32 index; /// @notice Output index
  uint64 value; /// @notice UTXO value in satoshis
  bytes scriptPubKey;
} /// @notice Output script for the UTXO being spent

/// @notice Bitcoin transaction parameters encoded in BuildPayloadParams.data.
struct BitcoinVmTransactionParams {
  BitcoinVmUtxo[] allocatorUtxos; /// @notice P2WPKH UTXOs controlled by the payload builder key; fund withdrawal amount
  BitcoinVmUtxo[] feeUtxos; /// @notice Extra UTXOs used only to pay network fees
  bytes feeChangeScript; /// @notice Standard scriptPubKey returning fee UTXO excess to its owner
  uint64 feeRate;
} /// @notice Fee rate in sats/vbyte

/// @notice Bitcoin transaction input data.
struct BitcoinVmTransactionDataInput {
  bytes txid;
  bytes index;
  bytes script;
  bytes value;
}

/// @notice Bitcoin transaction output data.
struct BitcoinVmTransactionDataOutput {
  bytes value;
  bytes script;
}

/// @notice Complete Bitcoin transaction data.
struct BitcoinVmTransactionData {
  BitcoinVmTransactionDataInput[] inputs;
  BitcoinVmTransactionDataOutput[] outputs;
}

/// @title BitcoinVmPayloadBuilder
/// @author Relay Protocol
/// @notice Builds P2WPKH Bitcoin withdrawal payloads with fee-only UTXOs and an OP_RETURN identifier.
contract BitcoinVmPayloadBuilder is IPayloadBuilder {
  error InsufficientAllocatorUtxoValue(uint64 totalInput, uint256 amount);
  error InsufficientFeeUtxoValue(uint64 totalInput, uint256 requiredFees);
  error OutputBelowDust(uint64 amount);
  error InvalidP2wpkhScript(bytes script);
  error InvalidBitcoinAddress(bytes encodedAddress);
  error InvalidBitcoinScript(bytes script);
  error AllocatorScriptMismatch(bytes expected, bytes actual);
  error FeeUtxoUsesAllocatorScript(bytes script);
  error InvalidHashIndex(uint256 hashIndex, uint256 inputsLength);

  /// @dev Minimum output value accepted by most Bitcoin nodes.
  uint64 private constant DUST_THRESHOLD = 546;

  /// @notice P2WPKH script used for allocator UTXO change.
  bytes public allocatorChangeScript;

  /// @notice Initializes Bitcoin payload builder with allocator change script.
  /// @param _allocatorChangeScript P2WPKH scriptPubKey or encoded bc1 address bytes for allocator change
  constructor(bytes memory _allocatorChangeScript) {
    allocatorChangeScript = _normalizeP2wpkhScript(_allocatorChangeScript);
  }

  /// @notice Builds a Bitcoin transaction payload.
  /// @dev The withdrawal output receives the full requested amount. Fees are paid only by feeUtxos.
  /// @dev params.receiver is a protocol-encoded Bitcoin address; UTXO script fields are scriptPubKeys.
  /// @dev Depository is included only in the OP_RETURN identifier; allocator identity is fixed by allocatorChangeScript.
  /// @return payload ABI-encoded Bitcoin transaction data.
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    BitcoinVmTransactionParams memory bitcoinParams = abi.decode(
      params.data,
      (BitcoinVmTransactionParams)
    );

    bytes memory receiverScript = _protocolAddressToScript(params.receiver);
    bytes memory feeChangeScript = bitcoinParams.feeChangeScript;
    _validateStandardOutputScript(feeChangeScript);

    uint64 allocatorChange = _computeAllocatorChange(
      params.amount,
      bitcoinParams.allocatorUtxos,
      allocatorChangeScript
    );

    _validateFeeUtxos(bitcoinParams.feeUtxos, allocatorChangeScript);

    bytes memory identifierScript = _buildIdentifierScript(
      chainId,
      depository,
      params
    );

    uint64 feeChange = _computeFeeChange(
      bitcoinParams,
      allocatorChange,
      receiverScript,
      identifierScript,
      allocatorChangeScript,
      feeChangeScript
    );

    payload = abi.encode(
      BitcoinVmTransactionData({
        inputs: _buildInputs(
          bitcoinParams.allocatorUtxos,
          bitcoinParams.feeUtxos
        ),
        outputs: _buildOutputs(
          uint64(params.amount),
          receiverScript,
          identifierScript,
          allocatorChange,
          allocatorChangeScript,
          feeChange,
          feeChangeScript
        )
      })
    );
  }

  /// @notice Returns one BIP143 SIGHASH_ALL digest per allocator-controlled transaction input.
  /// @return hashes Transaction input digests.
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external view override returns (bytes32[] memory hashes) {
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    uint256 allocatorInputs = _countAllocatorInputs(txData);
    hashes = new bytes32[](allocatorInputs);
    uint256 hashIndex;
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorChangeScript)) {
        hashes[hashIndex++] = _hashToSign(txData, i);
      }
    }
  }

  /// @notice Returns the BIP143 SIGHASH_ALL digest for one allocator input.
  /// @return Transaction input digest.
  function hashToSign(
    bytes calldata payload,
    uint256 hashIndex
  ) external view returns (bytes32) {
    BitcoinVmTransactionData memory txData = abi.decode(
      payload,
      (BitcoinVmTransactionData)
    );

    uint256 allocatorInputIndex = _allocatorInputIndex(txData, hashIndex);
    return _hashToSign(txData, allocatorInputIndex);
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "bitcoin-vm";
  }

  /// @notice Computes allocator change after funding the requested amount.
  /// @return change Allocator change amount in satoshis.
  function _computeAllocatorChange(
    uint256 amount,
    BitcoinVmUtxo[] memory allocatorUtxos,
    bytes memory allocatorScript
  ) internal pure returns (uint64 change) {
    uint64 totalInput = _sumAndValidateAllocatorUtxos(
      allocatorUtxos,
      allocatorScript
    );
    if (totalInput < amount) {
      revert InsufficientAllocatorUtxoValue(totalInput, amount);
    }

    change = totalInput - uint64(amount);
    if (change > 0 && change < DUST_THRESHOLD) {
      revert OutputBelowDust(change);
    }
  }

  /// @notice Computes fee UTXO change after paying the estimated transaction fee.
  /// @return feeChange Fee change amount in satoshis.
  function _computeFeeChange(
    BitcoinVmTransactionParams memory bitcoinParams,
    uint64 allocatorChange,
    bytes memory receiverScript,
    bytes memory identifierScript,
    bytes memory allocatorChangeScript_,
    bytes memory feeChangeScript
  ) internal pure returns (uint64 feeChange) {
    uint64 totalFeeInput = _sumUtxoValues(bitcoinParams.feeUtxos);
    bytes[] memory baseOutputScripts = new bytes[](
      2 + (allocatorChange > 0 ? 1 : 0)
    );
    baseOutputScripts[0] = receiverScript;
    baseOutputScripts[1] = identifierScript;
    if (allocatorChange > 0) {
      baseOutputScripts[2] = allocatorChangeScript_;
    }

    uint256 feeWithoutChange = _estimateVSize(
      bitcoinParams.allocatorUtxos,
      bitcoinParams.feeUtxos,
      baseOutputScripts
    ) * bitcoinParams.feeRate;

    if (totalFeeInput < feeWithoutChange) {
      revert InsufficientFeeUtxoValue(totalFeeInput, feeWithoutChange);
    }
    if (totalFeeInput == feeWithoutChange) {
      return 0;
    }

    bytes[] memory outputScriptsWithChange = new bytes[](
      baseOutputScripts.length + 1
    );
    for (uint256 i = 0; i < baseOutputScripts.length; ++i) {
      outputScriptsWithChange[i] = baseOutputScripts[i];
    }
    outputScriptsWithChange[baseOutputScripts.length] = feeChangeScript;

    uint256 feeWithChange = _estimateVSize(
      bitcoinParams.allocatorUtxos,
      bitcoinParams.feeUtxos,
      outputScriptsWithChange
    ) * bitcoinParams.feeRate;
    if (totalFeeInput < feeWithChange) {
      revert InsufficientFeeUtxoValue(totalFeeInput, feeWithChange);
    }

    feeChange = totalFeeInput - uint64(feeWithChange);
    if (feeChange < DUST_THRESHOLD) {
      revert OutputBelowDust(feeChange);
    }
  }

  /// @notice Sums allocator UTXO values after validating each script.
  /// @return total Total UTXO value in satoshis.
  function _sumAndValidateAllocatorUtxos(
    BitcoinVmUtxo[] memory utxos,
    bytes memory allocatorScript
  ) internal pure returns (uint64 total) {
    for (uint256 i = 0; i < utxos.length; ++i) {
      _validateP2wpkhScript(utxos[i].scriptPubKey);
      if (!_bytesEqual(utxos[i].scriptPubKey, allocatorScript)) {
        revert AllocatorScriptMismatch(allocatorScript, utxos[i].scriptPubKey);
      }
      total += utxos[i].value;
    }
  }

  /// @notice Validates fee UTXO scripts without requiring allocator control.
  function _validateFeeUtxos(
    BitcoinVmUtxo[] memory utxos,
    bytes memory allocatorScript
  ) internal pure {
    for (uint256 i = 0; i < utxos.length; ++i) {
      _validateStandardOutputScript(utxos[i].scriptPubKey);
      if (_bytesEqual(utxos[i].scriptPubKey, allocatorScript)) {
        revert FeeUtxoUsesAllocatorScript(utxos[i].scriptPubKey);
      }
    }
  }

  /// @notice Sums UTXO values without validating scripts.
  /// @return total Total UTXO value in satoshis.
  function _sumUtxoValues(
    BitcoinVmUtxo[] memory utxos
  ) internal pure returns (uint64 total) {
    for (uint256 i = 0; i < utxos.length; ++i) {
      total += utxos[i].value;
    }
  }

  /// @notice Builds Bitcoin transaction inputs from allocator and fee UTXOs.
  /// @return inputs Transaction input data.
  function _buildInputs(
    BitcoinVmUtxo[] memory allocatorUtxos,
    BitcoinVmUtxo[] memory feeUtxos
  ) internal pure returns (BitcoinVmTransactionDataInput[] memory inputs) {
    inputs = new BitcoinVmTransactionDataInput[](
      allocatorUtxos.length + feeUtxos.length
    );

    for (uint256 i = 0; i < allocatorUtxos.length; ++i) {
      inputs[i] = _buildInput(allocatorUtxos[i]);
    }
    for (uint256 i = 0; i < feeUtxos.length; ++i) {
      inputs[allocatorUtxos.length + i] = _buildInput(feeUtxos[i]);
    }
  }

  /// @notice Builds a Bitcoin transaction input from a UTXO.
  /// @return Transaction input data.
  function _buildInput(
    BitcoinVmUtxo memory utxo
  ) internal pure returns (BitcoinVmTransactionDataInput memory) {
    return
      BitcoinVmTransactionDataInput({
        txid: abi.encodePacked(utxo.txid),
        index: Utils.encodeUint32LE(utxo.index),
        script: utxo.scriptPubKey,
        value: Utils.encodeUint64LE(utxo.value)
      });
  }

  /// @notice Builds receiver, identifier, allocator change, and fee change outputs.
  /// @return outputs Transaction output data.
  function _buildOutputs(
    uint64 amount,
    bytes memory receiverScript,
    bytes memory identifierScript,
    uint64 allocatorChange,
    bytes memory allocatorChangeScript_,
    uint64 feeChange,
    bytes memory feeChangeScript
  ) internal pure returns (BitcoinVmTransactionDataOutput[] memory outputs) {
    if (amount < DUST_THRESHOLD) {
      revert OutputBelowDust(amount);
    }

    outputs = new BitcoinVmTransactionDataOutput[](
      2 + (allocatorChange > 0 ? 1 : 0) + (feeChange > 0 ? 1 : 0)
    );

    outputs[0] = BitcoinVmTransactionDataOutput({
      value: Utils.encodeUint64LE(amount),
      script: receiverScript
    });
    outputs[1] = BitcoinVmTransactionDataOutput({
      value: Utils.encodeUint64LE(0),
      script: identifierScript
    });

    uint256 outputIndex = 2;
    if (allocatorChange > 0) {
      outputs[outputIndex++] = BitcoinVmTransactionDataOutput({
        value: Utils.encodeUint64LE(allocatorChange),
        script: allocatorChangeScript_
      });
    }
    if (feeChange > 0) {
      outputs[outputIndex] = BitcoinVmTransactionDataOutput({
        value: Utils.encodeUint64LE(feeChange),
        script: feeChangeScript
      });
    }
  }

  /// @notice Builds an OP_RETURN output script containing a unique withdrawal identifier.
  /// @return script OP_RETURN PUSH32 script.
  function _buildIdentifierScript(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) internal view returns (bytes memory script) {
    bytes32 identifier = keccak256(
      abi.encode(address(this), chainId, depository, params)
    );
    return bytes.concat(hex"6a20", identifier);
  }

  /// @notice Builds BIP143 SIGHASH_ALL preimage for a P2WPKH input.
  /// @return BIP143 preimage bytes.
  function _buildPreImageForInput(
    BitcoinVmTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes memory) {
    BitcoinVmTransactionDataInput memory input = txData.inputs[whichInput];
    bytes memory outpoint = bytes.concat(input.txid, input.index);
    bytes memory scriptCode = _buildScriptCode(input.script);

    bytes memory firstHalf = bytes.concat(
      Utils.encodeUint32LE(1),
      _hashPrevouts(txData.inputs),
      _hashSequence(txData.inputs),
      outpoint,
      scriptCode
    );

    return
      bytes.concat(
        firstHalf,
        input.value,
        Utils.encodeUint32LE(0xFFFFFFFD),
        _hashOutputs(txData.outputs),
        Utils.encodeUint32LE(0),
        Utils.encodeUint32LE(0x01)
      );
  }

  /// @notice Hashes one input preimage using Bitcoin double-SHA256.
  /// @return BIP143 SIGHASH_ALL digest.
  function _hashToSign(
    BitcoinVmTransactionData memory txData,
    uint256 whichInput
  ) internal pure returns (bytes32) {
    bytes memory preimage = _buildPreImageForInput(txData, whichInput);
    return sha256(abi.encodePacked(sha256(preimage)));
  }

  /// @notice Hashes all transaction outpoints for BIP143.
  /// @return Double-SHA256 hash of all outpoints.
  function _hashPrevouts(
    BitcoinVmTransactionDataInput[] memory inputs
  ) internal pure returns (bytes32) {
    bytes memory allOutpoints;
    for (uint256 i = 0; i < inputs.length; ++i) {
      allOutpoints = bytes.concat(
        allOutpoints,
        inputs[i].txid,
        inputs[i].index
      );
    }
    return sha256(abi.encodePacked(sha256(allOutpoints)));
  }

  /// @notice Hashes all transaction input sequences for BIP143.
  /// @return Double-SHA256 hash of all input sequences.
  function _hashSequence(
    BitcoinVmTransactionDataInput[] memory inputs
  ) internal pure returns (bytes32) {
    bytes memory allSequences;
    for (uint256 i = 0; i < inputs.length; ++i) {
      allSequences = bytes.concat(
        allSequences,
        Utils.encodeUint32LE(0xFFFFFFFD)
      );
    }
    return sha256(abi.encodePacked(sha256(allSequences)));
  }

  /// @notice Hashes all transaction outputs for BIP143.
  /// @return Double-SHA256 hash of all outputs.
  function _hashOutputs(
    BitcoinVmTransactionDataOutput[] memory outputs
  ) internal pure returns (bytes32) {
    bytes memory allOutputs;
    for (uint256 i = 0; i < outputs.length; ++i) {
      bytes memory scriptPubKey = outputs[i].script;
      allOutputs = bytes.concat(
        allOutputs,
        outputs[i].value,
        _encodeVarInt(scriptPubKey.length),
        scriptPubKey
      );
    }
    return sha256(abi.encodePacked(sha256(allOutputs)));
  }

  /// @notice Builds the BIP143 scriptCode for a P2WPKH script.
  /// @return P2PKH scriptCode bytes.
  function _buildScriptCode(
    bytes memory scriptPubKey
  ) internal pure returns (bytes memory) {
    _validateP2wpkhScript(scriptPubKey);

    bytes memory pubkeyHash = new bytes(20);
    for (uint256 i = 0; i < 20; ++i) {
      pubkeyHash[i] = scriptPubKey[i + 2];
    }
    return abi.encodePacked(hex"1976a914", pubkeyHash, hex"88ac");
  }

  /// @notice Converts a protocol-encoded Bitcoin address to a scriptPubKey.
  /// @return scriptPubKey Normalized Bitcoin output script.
  function _protocolAddressToScript(
    bytes memory encodedAddress
  ) internal pure returns (bytes memory scriptPubKey) {
    if (encodedAddress.length == 22 && encodedAddress[0] == 0xFF) {
      bytes memory hash160 = _slice(encodedAddress, 2, 20);
      if (encodedAddress[1] == 0x00) {
        return bytes.concat(hex"76A914", hash160, hex"88AC");
      }
      if (encodedAddress[1] == 0x05) {
        return bytes.concat(hex"A914", hash160, hex"87");
      }
    }

    if (encodedAddress.length >= 3 && encodedAddress[0] <= 0x10) {
      uint8 version = uint8(encodedAddress[0]);
      uint256 programLength = encodedAddress.length - 1;
      if (version == 0 && (programLength == 20 || programLength == 32)) {
        return
          bytes.concat(
            hex"00",
            bytes1(uint8(programLength)),
            _slice(encodedAddress, 1, programLength)
          );
      }
      if (version > 0 && programLength >= 2 && programLength <= 40) {
        return
          bytes.concat(
            bytes1(uint8(0x50 + version)),
            bytes1(uint8(programLength)),
            _slice(encodedAddress, 1, programLength)
          );
      }
    }

    revert InvalidBitcoinAddress(encodedAddress);
  }

  /// @notice Accepts either P2WPKH scriptPubKey (0x0014{20}) or encoded bc1 address bytes (0x00{20}).
  /// @return scriptPubKey Normalized P2WPKH scriptPubKey.
  function _normalizeP2wpkhScript(
    bytes memory scriptOrAddress
  ) internal pure returns (bytes memory scriptPubKey) {
    if (_isP2wpkhScript(scriptOrAddress)) {
      return scriptOrAddress;
    }
    if (scriptOrAddress.length == 21 && scriptOrAddress[0] == 0x00) {
      return bytes.concat(hex"0014", _slice(scriptOrAddress, 1, 20));
    }
    revert InvalidP2wpkhScript(scriptOrAddress);
  }

  /// @notice Reverts unless the provided bytes are a P2WPKH scriptPubKey.
  function _validateP2wpkhScript(bytes memory scriptPubKey) internal pure {
    if (!_isP2wpkhScript(scriptPubKey)) {
      revert InvalidP2wpkhScript(scriptPubKey);
    }
  }

  /// @notice Reverts unless the provided bytes are a standard address scriptPubKey.
  function _validateStandardOutputScript(
    bytes memory scriptPubKey
  ) internal pure {
    if (!_isStandardOutputScript(scriptPubKey)) {
      revert InvalidBitcoinScript(scriptPubKey);
    }
  }

  /// @notice Checks whether bytes are a standard address scriptPubKey.
  /// @return True if the bytes are a standard address scriptPubKey.
  function _isStandardOutputScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    return
      _isP2pkhScript(scriptPubKey) ||
      _isP2shScript(scriptPubKey) ||
      _isWitnessScript(scriptPubKey);
  }

  /// @notice Checks whether bytes are a P2PKH scriptPubKey.
  /// @return True if the bytes are a P2PKH scriptPubKey.
  function _isP2pkhScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    return
      scriptPubKey.length == 25 &&
      scriptPubKey[0] == 0x76 &&
      scriptPubKey[1] == 0xA9 &&
      scriptPubKey[2] == 0x14 &&
      scriptPubKey[23] == 0x88 &&
      scriptPubKey[24] == 0xAC;
  }

  /// @notice Checks whether bytes are a P2SH scriptPubKey.
  /// @return True if the bytes are a P2SH scriptPubKey.
  function _isP2shScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    return
      scriptPubKey.length == 23 &&
      scriptPubKey[0] == 0xA9 &&
      scriptPubKey[1] == 0x14 &&
      scriptPubKey[22] == 0x87;
  }

  /// @notice Checks whether bytes are a witness program scriptPubKey.
  /// @return True if the bytes are a witness program scriptPubKey.
  function _isWitnessScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    if (scriptPubKey.length < 4 || scriptPubKey.length > 42) {
      return false;
    }
    uint8 version = uint8(scriptPubKey[0]);
    if (version != 0 && (version < 0x51 || version > 0x60)) {
      return false;
    }
    uint8 programLength = uint8(scriptPubKey[1]);
    if (programLength != scriptPubKey.length - 2) {
      return false;
    }
    if (version == 0) {
      return programLength == 20 || programLength == 32;
    }
    return programLength >= 2 && programLength <= 40;
  }

  /// @notice Checks whether bytes are a P2WPKH scriptPubKey.
  /// @return True if the bytes are a P2WPKH scriptPubKey.
  function _isP2wpkhScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    return
      scriptPubKey.length == 22 &&
      scriptPubKey[0] == 0x00 &&
      scriptPubKey[1] == 0x14;
  }

  /// @notice Checks whether bytes are a P2TR scriptPubKey.
  /// @return True if the bytes are a P2TR scriptPubKey.
  function _isP2trScript(
    bytes memory scriptPubKey
  ) internal pure returns (bool) {
    return
      scriptPubKey.length == 34 &&
      scriptPubKey[0] == 0x51 &&
      scriptPubKey[1] == 0x20;
  }

  /// @notice Estimates the virtual size of the transaction.
  /// @return Estimated transaction vsize in vbytes.
  function _estimateVSize(
    BitcoinVmUtxo[] memory allocatorUtxos,
    BitcoinVmUtxo[] memory feeUtxos,
    bytes[] memory outputScripts
  ) internal pure returns (uint256) {
    uint256 inputCount = allocatorUtxos.length + feeUtxos.length;
    uint256 baseSize = 4 + _compactSizeLength(inputCount);
    uint256 witnessSize;

    for (uint256 i = 0; i < allocatorUtxos.length; ++i) {
      baseSize += 41;
      witnessSize += 107;
    }
    for (uint256 i = 0; i < feeUtxos.length; ++i) {
      baseSize += _estimatedInputBaseSize(feeUtxos[i].scriptPubKey);
      witnessSize += _estimatedInputWitnessSize(feeUtxos[i].scriptPubKey);
    }

    baseSize += _compactSizeLength(outputScripts.length);
    for (uint256 i = 0; i < outputScripts.length; ++i) {
      baseSize +=
        8 +
        _compactSizeLength(outputScripts[i].length) +
        outputScripts[i].length;
    }
    baseSize += 4;

    if (witnessSize > 0) {
      witnessSize += 2; // SegWit marker and flag.
    }

    return ((baseSize * 4) + witnessSize + 3) / 4;
  }

  /// @notice Estimates non-witness bytes for an input spending the provided scriptPubKey.
  /// @return Estimated non-witness input size in bytes.
  function _estimatedInputBaseSize(
    bytes memory scriptPubKey
  ) internal pure returns (uint256) {
    if (_isP2pkhScript(scriptPubKey)) {
      return 148;
    }
    if (_isP2shScript(scriptPubKey)) {
      // Conservative standard P2SH scriptSig upper bound.
      return 32 + 4 + _compactSizeLength(1650) + 1650 + 4;
    }
    if (_isWitnessScript(scriptPubKey)) {
      return 41;
    }
    revert InvalidBitcoinScript(scriptPubKey);
  }

  /// @notice Estimates witness bytes for an input spending the provided scriptPubKey.
  /// @return Estimated witness input size in bytes.
  function _estimatedInputWitnessSize(
    bytes memory scriptPubKey
  ) internal pure returns (uint256) {
    if (_isP2wpkhScript(scriptPubKey)) {
      return 107;
    }
    if (_isP2trScript(scriptPubKey)) {
      return 67;
    }
    if (_isWitnessScript(scriptPubKey)) {
      // Conservative standard witness upper bound for P2WSH and future witness versions.
      return 3600;
    }
    return 0;
  }

  /// @notice Returns the byte length of a Bitcoin CompactSize integer.
  /// @return CompactSize encoded length in bytes.
  function _compactSizeLength(uint256 value) internal pure returns (uint256) {
    if (value < 0xFD) {
      return 1;
    } else if (value <= 0xFFFF) {
      return 3;
    } else if (value <= 0xFFFFFFFF) {
      return 5;
    }
    return 9;
  }

  /// @notice Counts inputs that spend allocator-controlled UTXOs.
  /// @return count Number of allocator-controlled inputs.
  function _countAllocatorInputs(
    BitcoinVmTransactionData memory txData
  ) internal view returns (uint256 count) {
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorChangeScript)) {
        ++count;
      }
    }
  }

  /// @notice Returns the input index for a hash index over allocator inputs.
  /// @return inputIndex Transaction input index for the allocator hash index.
  function _allocatorInputIndex(
    BitcoinVmTransactionData memory txData,
    uint256 hashIndex
  ) internal view returns (uint256 inputIndex) {
    uint256 allocatorInputs;
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorChangeScript)) {
        if (allocatorInputs == hashIndex) {
          return i;
        }
        ++allocatorInputs;
      }
    }
    revert InvalidHashIndex(hashIndex, allocatorInputs);
  }

  /// @notice Compares two byte arrays.
  /// @return True if the arrays have identical contents.
  function _bytesEqual(
    bytes memory a,
    bytes memory b
  ) internal pure returns (bool) {
    if (a.length != b.length) {
      return false;
    }
    for (uint256 i = 0; i < a.length; ++i) {
      if (a[i] != b[i]) {
        return false;
      }
    }
    return true;
  }

  /// @notice Encodes a value as a Bitcoin CompactSize integer.
  /// @return CompactSize encoded bytes.
  function _encodeVarInt(uint256 value) internal pure returns (bytes memory) {
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
    }
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

  /// @notice Copies a byte range from memory.
  /// @return out Copied byte range.
  function _slice(
    bytes memory data,
    uint256 start,
    uint256 length
  ) internal pure returns (bytes memory out) {
    out = new bytes(length);
    for (uint256 i = 0; i < length; ++i) {
      out[i] = data[start + i];
    }
  }
}
