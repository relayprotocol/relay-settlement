// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {
  Ownable2Step,
  Ownable
} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RelayOracleMultisig
/// @author Relay Protocol
/// @notice A multisig contract implementing EIP-1271 for use as an oracle in RelayOracle.
/// @dev Management operations (add/remove signer, set threshold) are controlled by the owner.
/// Signatures must be sorted by signer address in ascending order.
contract RelayOracleMultisig is IERC1271, EIP712, Ownable2Step {
  // EIP-1271 magic value for valid signatures
  bytes4 private constant _EIP1271_MAGIC_VALUE = 0x1626ba7e;

  // Events
  /// @notice Emitted when a signer is added
  event SignerAdded(address indexed signer);
  /// @notice Emitted when a signer is removed
  event SignerRemoved(address indexed signer);
  /// @notice Emitted when the signature threshold changes
  event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

  // Errors
  error InvalidThreshold(uint256 threshold, uint256 signerCount);
  error SignerAlreadyExists(address signer);
  error SignerDoesNotExist(address signer);
  error InvalidSignerAddress();
  error InvalidSignatureCount(uint256 provided, uint256 required);
  error InvalidSignatureOrder();
  error DuplicateSignature(address signer);
  error SignerNotAuthorized(address signer);
  error InvalidSignature(address signer);
  error CannotRemoveLastSigner();

  // State
  /// @notice Returns true if an address is an authorized signer
  mapping(address => bool) public isSigner;
  /// @notice List of signer addresses
  address[] public signers;
  /// @notice Current signature threshold
  uint256 public threshold;

  /// @notice Constructor
  /// @param _owner Address of the contract owner
  /// @param _signers Initial list of signers
  /// @param _threshold Minimum number of signatures required
  constructor(
    address _owner,
    address[] memory _signers,
    uint256 _threshold
  ) EIP712("RelayOracleMultisig", "1") Ownable(_owner) {
    if (_signers.length == 0) {
      revert InvalidThreshold(_threshold, 0);
    }
    if (_threshold == 0 || _threshold > _signers.length) {
      revert InvalidThreshold(_threshold, _signers.length);
    }

    for (uint256 i = 0; i < _signers.length; i++) {
      address signer = _signers[i];
      if (signer == address(0)) {
        revert InvalidSignerAddress();
      }
      if (isSigner[signer]) {
        revert SignerAlreadyExists(signer);
      }
      isSigner[signer] = true;
      signers.push(signer);
      emit SignerAdded(signer);
    }

    threshold = _threshold;
    emit ThresholdChanged(0, _threshold);
  }

  // ============ EIP-1271 Implementation ============

  /// @notice Validates a signature according to EIP-1271
  /// @param hash The hash that was signed
  /// @param signature Concatenated signatures (65 bytes each), sorted by signer address
  /// @return magicValue EIP-1271 magic value if valid, 0 otherwise
  function isValidSignature(
    bytes32 hash,
    bytes memory signature
  ) external view override returns (bytes4 magicValue) {
    if (_validateSignatures(hash, signature)) {
      return _EIP1271_MAGIC_VALUE;
    }
    return bytes4(0);
  }

  // ============ Management Functions ============

  /// @notice Adds a new signer
  /// @param signer Address to add as signer
  function addSigner(address signer) external onlyOwner {
    if (signer == address(0)) {
      revert InvalidSignerAddress();
    }
    if (isSigner[signer]) {
      revert SignerAlreadyExists(signer);
    }

    isSigner[signer] = true;
    signers.push(signer);

    emit SignerAdded(signer);
  }

  /// @notice Removes a signer
  /// @param signer Address to remove
  function removeSigner(address signer) external onlyOwner {
    if (!isSigner[signer]) {
      revert SignerDoesNotExist(signer);
    }
    if (signers.length == 1) {
      revert CannotRemoveLastSigner();
    }
    if (signers.length - 1 < threshold) {
      revert InvalidThreshold(threshold, signers.length - 1);
    }

    isSigner[signer] = false;

    // Remove from array
    for (uint256 i = 0; i < signers.length; i++) {
      if (signers[i] == signer) {
        signers[i] = signers[signers.length - 1];
        signers.pop();
        break;
      }
    }

    emit SignerRemoved(signer);
  }

  /// @notice Changes the signature threshold
  /// @param newThreshold New threshold value
  function setThreshold(uint256 newThreshold) external onlyOwner {
    if (newThreshold == 0 || newThreshold > signers.length) {
      revert InvalidThreshold(newThreshold, signers.length);
    }

    uint256 oldThreshold = threshold;
    threshold = newThreshold;

    emit ThresholdChanged(oldThreshold, newThreshold);
  }

  // ============ View Functions ============

  /// @notice Returns all signers
  /// @return Array of signer addresses
  function getSigners() external view returns (address[] memory) {
    return signers;
  }

  /// @notice Returns the number of signers
  /// @return Number of signers
  function getSignerCount() external view returns (uint256) {
    return signers.length;
  }

  // ============ Internal Functions ============

  /// @notice Validates that enough valid signatures are provided
  /// @param digest The message digest that was signed
  /// @param signatures Concatenated signatures (65 bytes each)
  /// @return True if valid, false otherwise
  function _validateSignatures(
    bytes32 digest,
    bytes memory signatures
  ) internal view returns (bool) {
    uint256 signatureCount = signatures.length / 65;

    if (signatureCount < threshold) {
      return false;
    }

    address lastSigner = address(0);

    for (uint256 i = 0; i < threshold; i++) {
      // Extract signature components
      bytes32 r;
      bytes32 s;
      uint8 v;

      assembly {
        let signaturePos := add(signatures, add(32, mul(i, 65)))
        r := mload(signaturePos)
        s := mload(add(signaturePos, 32))
        v := byte(0, mload(add(signaturePos, 64)))
      }

      // Recover signer; treat invalid signatures as failure instead of reverting
      (address signer, ECDSA.RecoverError recoverError, ) = ECDSA.tryRecover(
        digest,
        v,
        r,
        s
      );
      if (recoverError != ECDSA.RecoverError.NoError) {
        return false;
      }

      // Ensure signatures are sorted by signer address (ascending)
      // This also prevents duplicate signatures
      if (signer <= lastSigner) {
        return false;
      }

      // Ensure signer is authorized
      if (!isSigner[signer]) {
        return false;
      }

      lastSigner = signer;
    }

    return true;
  }
}
