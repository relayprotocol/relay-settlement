// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ILegacyRelayGenericMapping
/// @author Relay Protocol
/// @notice Read interface of a previous RelayGenericMapping deployment
interface ILegacyRelayGenericMapping {
  /// @notice Get an entry for a user
  /// @param user The user address
  /// @param id The entry identifier
  /// @return data The stored data bytes
  /// @return createdAt The timestamp when the entry was set, or 0 if missing
  function getEntry(
    address user,
    bytes32 id
  ) external view returns (bytes memory data, uint256 createdAt);
}

/// @title RelayGenericMapping
/// @author Relay Protocol
/// @notice Stores arbitrary per-user entries gated by oracle EIP-712 signature verification
/// @dev When deployed with a legacy mapping, entries of the legacy mapping read
///      through as if stored here, until this contract sets or deletes the same
///      (user, id). The legacy mapping must be frozen (its oracles revoked) so its
///      entries can no longer change.
contract RelayGenericMapping is AccessControl, EIP712 {
  using SignatureChecker for address;

  // Roles

  /// @notice Admin role — can grant/revoke ORACLE_ROLE
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role — addresses whose signatures authorize entry mutations
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice The type hash for SetEntry
  bytes32 public constant SET_ENTRY_TYPEHASH =
    keccak256(
      "SetEntry(address user,bytes32 id,bytes data,bytes32 nonce,uint256 expiration)"
    );

  /// @notice The type hash for DeleteEntry
  bytes32 public constant DELETE_ENTRY_TYPEHASH =
    keccak256(
      "DeleteEntry(address user,bytes32 id,bytes32 nonce,uint256 expiration)"
    );

  // Types

  /// @notice Entry struct storing data and creation timestamp
  struct Entry {
    bytes data;
    uint256 createdAt;
  }

  // Immutables

  /// @notice Previous RelayGenericMapping whose entries read through, or address(0)
  ILegacyRelayGenericMapping public immutable LEGACY;

  // Storage

  /// @notice Mapping from user address to (id => Entry)
  mapping(address => mapping(bytes32 => Entry)) internal _entries;

  /// @notice Mapping of used nonces to prevent replay attacks
  mapping(bytes32 => bool) public usedNonces;

  /// @notice Entries deleted here, which no longer read through to LEGACY
  mapping(address => mapping(bytes32 => bool)) public legacyEntryDeleted;

  // Events

  /// @notice Emitted when an entry is set
  /// @param user The user address
  /// @param id The entry identifier
  /// @param data The entry data
  event EntrySet(address indexed user, bytes32 indexed id, bytes data);

  /// @notice Emitted when an entry is deleted
  /// @param user The user address
  /// @param id The entry identifier
  event EntryDeleted(address indexed user, bytes32 indexed id);

  // Errors

  error EmptyId();
  error EmptyData();
  error EntryAlreadyExists(address user, bytes32 id);
  error EntryNotFound(address user, bytes32 id);
  error NonceAlreadyUsed(bytes32 nonce);
  error UnauthorizedOracle(address oracle);
  error InvalidOracleSignature(address oracle);
  error SignatureExpired(uint256 expiration);
  error InvalidLegacy(address legacy);

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param legacy Previous RelayGenericMapping to read through, or address(0)
  constructor(
    address admin,
    address legacy
  ) EIP712("RelayGenericMapping", "1") {
    if (legacy != address(0) && legacy.code.length == 0) {
      revert InvalidLegacy(legacy);
    }
    LEGACY = ILegacyRelayGenericMapping(legacy);
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
  }

  /// @notice Set an entry for a user after verifying oracle signature
  /// @param user The user address
  /// @param id The entry identifier
  /// @param data The entry data (arbitrary bytes)
  /// @param nonce Unique nonce to prevent replay attacks
  /// @param expiration Last valid Unix timestamp in seconds for the signature
  /// @param oracleMultisig The RelayInboxMultisig contract address that signed the request
  /// @param oracleSignature The oracle's EIP-712 signature
  function setEntry(
    address user,
    bytes32 id,
    bytes calldata data,
    bytes32 nonce,
    uint256 expiration,
    address oracleMultisig,
    bytes calldata oracleSignature
  ) external {
    if (block.timestamp > expiration) revert SignatureExpired(expiration);
    if (id == bytes32(0)) revert EmptyId();
    if (data.length == 0) revert EmptyData();
    (, uint256 createdAt) = _getEntry(user, id);
    if (createdAt > 0) revert EntryAlreadyExists(user, id);
    if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);

    if (!hasRole(ORACLE_ROLE, oracleMultisig)) {
      revert UnauthorizedOracle(oracleMultisig);
    }

    bytes32 digest = _hashTypedDataV4(
      keccak256(
        abi.encode(
          SET_ENTRY_TYPEHASH,
          user,
          id,
          keccak256(data),
          nonce,
          expiration
        )
      )
    );

    if (!oracleMultisig.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(oracleMultisig);
    }

    usedNonces[nonce] = true;
    _entries[user][id] = Entry(data, block.timestamp);
    emit EntrySet(user, id, data);
  }

  /// @notice Delete an entry for a user after verifying oracle signature
  /// @param user The user address
  /// @param id The entry identifier
  /// @param nonce Unique nonce to prevent replay attacks
  /// @param expiration Last valid Unix timestamp in seconds for the signature
  /// @param oracleMultisig The RelayInboxMultisig contract address that signed the request
  /// @param oracleSignature The oracle's EIP-712 signature
  function deleteEntry(
    address user,
    bytes32 id,
    bytes32 nonce,
    uint256 expiration,
    address oracleMultisig,
    bytes calldata oracleSignature
  ) external {
    if (block.timestamp > expiration) revert SignatureExpired(expiration);
    if (id == bytes32(0)) revert EmptyId();
    (, uint256 createdAt) = _getEntry(user, id);
    if (createdAt == 0) revert EntryNotFound(user, id);
    if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);

    if (!hasRole(ORACLE_ROLE, oracleMultisig)) {
      revert UnauthorizedOracle(oracleMultisig);
    }

    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(DELETE_ENTRY_TYPEHASH, user, id, nonce, expiration))
    );

    if (!oracleMultisig.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(oracleMultisig);
    }

    usedNonces[nonce] = true;
    delete _entries[user][id];
    // Stop any legacy entry for (user, id) from reading through again
    if (address(LEGACY) != address(0)) legacyEntryDeleted[user][id] = true;
    emit EntryDeleted(user, id);
  }

  /// @notice Get an entry for a user, falling back to the legacy mapping
  /// @param user The user address
  /// @param id The entry identifier
  /// @return data The stored data bytes
  /// @return createdAt The timestamp when the entry was set
  function getEntry(
    address user,
    bytes32 id
  ) external view returns (bytes memory data, uint256 createdAt) {
    return _getEntry(user, id);
  }

  /// @notice Resolve an entry from local storage, then LEGACY unless deleted here
  /// @param user The user address
  /// @param id The entry identifier
  /// @return data The stored data bytes
  /// @return createdAt The timestamp when the entry was set, or 0 if missing
  function _getEntry(
    address user,
    bytes32 id
  ) internal view returns (bytes memory data, uint256 createdAt) {
    Entry storage entry = _entries[user][id];
    if (
      entry.createdAt > 0 ||
      address(LEGACY) == address(0) ||
      legacyEntryDeleted[user][id]
    ) {
      return (entry.data, entry.createdAt);
    }
    return LEGACY.getEntry(user, id);
  }
}
