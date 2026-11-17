// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "../Config.sol";
import {
  IPayloadBuilder,
  WithdrawRequest,
  WithdrawFee
} from "../RelayAllocator.sol";

/// @notice Bitcoin UTXO structure.
struct BitcoinVmUtxo {
  bytes32 txid; /// @notice Transaction ID in little-endian format
  uint32 index; /// @notice Output index
  uint64 value; /// @notice UTXO value in satoshis
  bytes scriptPubKey;
} /// @notice Output script for the UTXO being spent

/// @notice Bitcoin transaction parameters encoded in WithdrawRequest.data.
struct BitcoinVmTransactionParams {
  BitcoinVmUtxo[] allocatorUtxos; /// @notice P2WPKH UTXOs controlled by the payload builder key; fund withdrawal amount
  BitcoinVmUtxo[] feeUtxos; /// @notice Extra UTXOs used only to pay network fees
  bytes feeChangeScript; /// @notice Standard scriptPubKey returning fee UTXO excess to its owner
  uint64 feeRate;
} /// @notice Fee rate in sats/vbyte

/// @notice Bitcoin transaction input data.
/// @dev `txid` holds the 32 bytes exactly as they appear in a serialized outpoint
///      (Bitcoin's internal byte order, the reverse of the hex txid shown by block
///      explorers and RPCs). `index` and `value` are plain integers; they are
///      serialized as 4-byte and 8-byte little-endian values when hashed.
struct BitcoinVmTransactionDataInput {
  bytes32 txid; /// @notice Previous transaction ID in serialized outpoint byte order
  uint32 index; /// @notice Previous output index
  bytes script; /// @notice scriptPubKey of the output being spent
  uint64 value;
} /// @notice Value of the output being spent in satoshis

/// @notice Bitcoin transaction output data.
/// @dev `value` is a plain integer serialized as an 8-byte little-endian value when hashed.
struct BitcoinVmTransactionDataOutput {
  uint64 value; /// @notice Output value in satoshis
  bytes script;
} /// @notice Output scriptPubKey

/// @notice BIP143 digests shared by every input of one transaction.
struct SharedSighashData {
  bytes32 hashPrevouts;
  bytes32 hashSequence;
  bytes32 hashOutputs;
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
  error TooManyInputs(uint256 inputCount, uint256 maxInputs);
  error DuplicateOutpoint(bytes32 txid, uint32 index);
  error InvalidCurrency(bytes currency);

  /// @notice Config contract used to resolve the optional total input limit.
  Config public immutable CONFIG;

  /// @dev Protocol-encoded native BTC sentinel (bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8):
  ///      witness version 0 followed by its 19-byte zero program, so 20 zero bytes. This is
  ///      the SDK encoding the Hub token id of native BTC is derived from.
  bytes private constant NATIVE_CURRENCY =
    hex"00_00000000000000000000000000000000000000";

  /// @dev Minimum output value accepted by most Bitcoin nodes.
  uint64 private constant DUST_THRESHOLD = 546;

  // Item count, length prefixes, a 72-byte low-S DER signature with sighash byte, and compressed key.
  uint256 private constant P2WPKH_WITNESS_SIZE = 108;

  /// @dev Transaction version 1, serialized little-endian.
  bytes4 private constant TX_VERSION_LE = 0x01000000;

  /// @dev Input sequence 0xFFFFFFFD (opt-in RBF), serialized little-endian.
  bytes4 private constant SEQUENCE_LE = 0xFDFFFFFF;

  /// @dev Transaction locktime 0, serialized little-endian.
  bytes4 private constant LOCKTIME_LE = 0x00000000;

  /// @dev SIGHASH_ALL, serialized as a 4-byte little-endian value.
  bytes4 private constant SIGHASH_ALL_LE = 0x01000000;

  /// @notice P2WPKH script used for allocator UTXO change.
  bytes public allocatorChangeScript;

  /// @notice Initializes Bitcoin payload builder with allocator change script.
  /// @param _config Config contract address
  /// @param _allocatorChangeScript P2WPKH scriptPubKey or encoded bc1 address bytes for allocator change
  constructor(address _config, bytes memory _allocatorChangeScript) {
    CONFIG = Config(_config);
    allocatorChangeScript = _normalizeP2wpkhScript(_allocatorChangeScript);
  }

  /// @notice Builds a Bitcoin transaction payload.
  /// @dev The withdrawal output receives the full requested amount. Fees are paid only by feeUtxos.
  /// @dev params.receiver is a protocol-encoded Bitcoin address; UTXO script fields are scriptPubKeys.
  /// @dev Depository is included only in the OP_RETURN identifier; allocator identity is fixed by allocatorChangeScript.
  /// @return payload ABI-encoded Bitcoin transaction data.
  /// @return withdrawFee Zero additional Hub fee; Bitcoin fees remain in the transaction inputs
  function buildPayload(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    WithdrawRequest calldata params
  )
    external
    view
    override
    returns (bytes memory payload, WithdrawFee memory withdrawFee)
  {
    if (keccak256(params.currency) != keccak256(NATIVE_CURRENCY)) {
      revert InvalidCurrency(params.currency);
    }

    BitcoinVmTransactionParams memory bitcoinParams = abi.decode(
      params.data,
      (BitcoinVmTransactionParams)
    );

    uint256 inputCount = bitcoinParams.allocatorUtxos.length +
      bitcoinParams.feeUtxos.length;
    uint256 maxInputs = getMaxInputs();
    if (maxInputs != 0 && inputCount > maxInputs) {
      revert TooManyInputs(inputCount, maxInputs);
    }
    _assertDistinctOutpoints(
      bitcoinParams.allocatorUtxos,
      bitcoinParams.feeUtxos
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

    bytes memory identifierScript = _buildIdentifierScript(params);

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

  /// @notice Returns the config key for the total Bitcoin input limit.
  /// @return key Config key shared by Bitcoin payload builders.
  function getMaxInputsKey() public pure returns (bytes32 key) {
    return keccak256("BITCOIN_VM_MAX_INPUTS");
  }

  /// @notice Returns the configured total input limit; unset or zero means unrestricted.
  /// @dev Any config lookup revert defaults to zero.
  /// @return maxInputs Maximum combined allocator and fee input count, or zero.
  function getMaxInputs() public view returns (uint256 maxInputs) {
    bytes32 key = getMaxInputsKey();
    try CONFIG.getConfigValue(key) returns (bytes32 value) {
      return uint256(value);
    } catch {
      return 0;
    }
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

    bytes memory allocatorScript = allocatorChangeScript;
    uint256 allocatorInputs = _countAllocatorInputs(txData, allocatorScript);
    hashes = new bytes32[](allocatorInputs);
    if (allocatorInputs == 0) {
      return hashes;
    }

    SharedSighashData memory shared = _sharedSighashData(txData);
    uint256 hashIndex;
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorScript)) {
        hashes[hashIndex++] = _hashToSign(txData.inputs[i], shared);
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

    uint256 allocatorInputIndex = _allocatorInputIndex(
      txData,
      hashIndex,
      allocatorChangeScript
    );
    return
      _hashToSign(
        txData.inputs[allocatorInputIndex],
        _sharedSighashData(txData)
      );
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "bitcoin-vm";
  }

  /// @notice Reverts when any outpoint appears twice across both UTXO lists.
  /// @dev Values are summed by array position and the two lists are concatenated
  ///      into one input set, so a repeat is counted as many times as it appears
  ///      while funding the spend only once. Quadratic, and bounded only when
  ///      `BITCOIN_VM_MAX_INPUTS` is set — unset, zero or a reverting lookup
  ///      leaves the count unrestricted. Safe regardless: this is `view`, runs
  ///      before the burn in `_submitWithdrawRequest`, and the submitter pays
  ///      its own gas.
  function _assertDistinctOutpoints(
    BitcoinVmUtxo[] memory allocatorUtxos,
    BitcoinVmUtxo[] memory feeUtxos
  ) internal pure {
    uint256 total = allocatorUtxos.length + feeUtxos.length;
    for (uint256 i = 0; i < total; ++i) {
      BitcoinVmUtxo memory a = i < allocatorUtxos.length
        ? allocatorUtxos[i]
        : feeUtxos[i - allocatorUtxos.length];
      for (uint256 j = i + 1; j < total; ++j) {
        BitcoinVmUtxo memory b = j < allocatorUtxos.length
          ? allocatorUtxos[j]
          : feeUtxos[j - allocatorUtxos.length];
        if (a.txid == b.txid && a.index == b.index) {
          revert DuplicateOutpoint(a.txid, a.index);
        }
      }
    }
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
    if (feeChange > 0 && feeChange < DUST_THRESHOLD) {
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
        txid: utxo.txid,
        index: utxo.index,
        script: utxo.scriptPubKey,
        value: utxo.value
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
      value: amount,
      script: receiverScript
    });
    outputs[1] = BitcoinVmTransactionDataOutput({
      value: 0,
      script: identifierScript
    });

    uint256 outputIndex = 2;
    if (allocatorChange > 0) {
      outputs[outputIndex++] = BitcoinVmTransactionDataOutput({
        value: allocatorChange,
        script: allocatorChangeScript_
      });
    }
    if (feeChange > 0) {
      outputs[outputIndex] = BitcoinVmTransactionDataOutput({
        value: feeChange,
        script: feeChangeScript
      });
    }
  }

  /// @notice Builds an OP_RETURN output script containing a unique withdrawal identifier.
  /// @return script OP_RETURN PUSH32 script.
  function _buildIdentifierScript(
    WithdrawRequest calldata params
  ) internal view returns (bytes memory script) {
    bytes32 identifier = keccak256(abi.encode(address(this), params));
    return bytes.concat(hex"6a20", identifier);
  }

  /// @notice Computes the BIP143 digests shared by every input of a transaction.
  /// @return shared hashPrevouts, hashSequence and hashOutputs.
  function _sharedSighashData(
    BitcoinVmTransactionData memory txData
  ) internal pure returns (SharedSighashData memory shared) {
    shared.hashPrevouts = _hashPrevouts(txData.inputs);
    shared.hashSequence = _hashSequence(txData.inputs.length);
    shared.hashOutputs = _hashOutputs(txData.outputs);
  }

  /// @notice Builds and double-SHA256 hashes the BIP143 SIGHASH_ALL preimage for a P2WPKH input.
  /// @return BIP143 SIGHASH_ALL digest.
  function _hashToSign(
    BitcoinVmTransactionDataInput memory input,
    SharedSighashData memory shared
  ) internal pure returns (bytes32) {
    bytes memory preimage = abi.encodePacked(
      TX_VERSION_LE,
      shared.hashPrevouts,
      shared.hashSequence,
      input.txid,
      _toLittleEndian32(input.index),
      _buildScriptCode(input.script),
      _toLittleEndian64(input.value),
      SEQUENCE_LE,
      shared.hashOutputs,
      LOCKTIME_LE,
      SIGHASH_ALL_LE
    );
    return sha256(abi.encodePacked(sha256(preimage)));
  }

  /// @notice Hashes all transaction outpoints for BIP143.
  /// @return Double-SHA256 hash of all outpoints.
  function _hashPrevouts(
    BitcoinVmTransactionDataInput[] memory inputs
  ) internal pure returns (bytes32) {
    // Each outpoint is the 32-byte txid followed by the 4-byte little-endian index.
    bytes memory allOutpoints = new bytes(inputs.length * 36);
    for (uint256 i = 0; i < inputs.length; ++i) {
      bytes32 txid = inputs[i].txid;
      bytes4 index = _toLittleEndian32(inputs[i].index);
      // solhint-disable-next-line no-inline-assembly
      assembly ("memory-safe") {
        let ptr := add(add(allOutpoints, 32), mul(i, 36))
        mstore(ptr, txid)
        // Also writes 28 zero bytes after the index. They are overwritten by the
        // next outpoint or, for the last one, land in unallocated memory.
        mstore(add(ptr, 32), index)
      }
    }
    return sha256(abi.encodePacked(sha256(allOutpoints)));
  }

  /// @notice Hashes all transaction input sequences for BIP143.
  /// @return Double-SHA256 hash of all input sequences.
  function _hashSequence(uint256 inputCount) internal pure returns (bytes32) {
    bytes memory allSequences = new bytes(inputCount * 4);
    for (uint256 i = 0; i < allSequences.length; i += 4) {
      allSequences[i] = SEQUENCE_LE[0];
      allSequences[i + 1] = SEQUENCE_LE[1];
      allSequences[i + 2] = SEQUENCE_LE[2];
      allSequences[i + 3] = SEQUENCE_LE[3];
    }
    return sha256(abi.encodePacked(sha256(allSequences)));
  }

  /// @notice Hashes all transaction outputs for BIP143.
  /// @dev A built payload has at most four outputs, so appending is cheap.
  /// @return Double-SHA256 hash of all outputs.
  function _hashOutputs(
    BitcoinVmTransactionDataOutput[] memory outputs
  ) internal pure returns (bytes32) {
    bytes memory allOutputs;
    for (uint256 i = 0; i < outputs.length; ++i) {
      bytes memory scriptPubKey = outputs[i].script;
      allOutputs = bytes.concat(
        allOutputs,
        _toLittleEndian64(outputs[i].value),
        _encodeVarInt(scriptPubKey.length),
        scriptPubKey
      );
    }
    return sha256(abi.encodePacked(sha256(allOutputs)));
  }

  /// @notice Serializes a uint32 as 4 little-endian bytes.
  /// @return Little-endian bytes.
  function _toLittleEndian32(uint32 value) internal pure returns (bytes4) {
    value = ((value & 0xFF00FF00) >> 8) | ((value & 0x00FF00FF) << 8);
    return bytes4((value >> 16) | (value << 16));
  }

  /// @notice Serializes a uint64 as 8 little-endian bytes.
  /// @return Little-endian bytes.
  function _toLittleEndian64(uint64 value) internal pure returns (bytes8) {
    value =
      ((value & 0xFF00FF00FF00FF00) >> 8) | ((value & 0x00FF00FF00FF00FF) << 8);
    value =
      ((value & 0xFFFF0000FFFF0000) >> 16) |
      ((value & 0x0000FFFF0000FFFF) << 16);
    return bytes8((value >> 32) | (value << 32));
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
      // v2+ and non-32-byte v1 programs are anyone-can-spend under current consensus.
      if (version == 1 && programLength == 32) {
        return bytes.concat(hex"5120", _slice(encodedAddress, 1, 32));
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
    // v2+ programs are anyone-can-spend under current consensus.
    if (version != 0 && version != 0x51) {
      return false;
    }
    uint8 programLength = uint8(scriptPubKey[1]);
    if (programLength != scriptPubKey.length - 2) {
      return false;
    }
    if (version == 0) {
      return programLength == 20 || programLength == 32;
    }
    // BIP-341: witness v1 programs that are not 32 bytes are anyone-can-spend.
    return programLength == 32;
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
      witnessSize += P2WPKH_WITNESS_SIZE;
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
      return P2WPKH_WITNESS_SIZE;
    }
    if (_isP2trScript(scriptPubKey)) {
      return 67;
    }
    if (_isWitnessScript(scriptPubKey)) {
      // Conservative standard witness upper bound for P2WSH.
      return 3600;
    }
    // Empty witness stack count for non-witness inputs in a SegWit transaction.
    return 1;
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
    BitcoinVmTransactionData memory txData,
    bytes memory allocatorScript
  ) internal pure returns (uint256 count) {
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorScript)) {
        ++count;
      }
    }
  }

  /// @notice Returns the input index for a hash index over allocator inputs.
  /// @return inputIndex Transaction input index for the allocator hash index.
  function _allocatorInputIndex(
    BitcoinVmTransactionData memory txData,
    uint256 hashIndex,
    bytes memory allocatorScript
  ) internal pure returns (uint256 inputIndex) {
    uint256 allocatorInputs;
    for (uint256 i = 0; i < txData.inputs.length; ++i) {
      if (_bytesEqual(txData.inputs[i].script, allocatorScript)) {
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
