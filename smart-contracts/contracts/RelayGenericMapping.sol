// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title RelayGenericMapping
/// @author Relay Protocol
/// @notice Stores arbitrary per-user entries gated by oracle EIP-712 signature verification
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
    keccak256("SetEntry(address user,bytes32 id,bytes data,bytes32 nonce)");

  /// @notice The type hash for DeleteEntry
  bytes32 public constant DELETE_ENTRY_TYPEHASH =
    keccak256("DeleteEntry(address user,bytes32 id,bytes32 nonce)");

  // Types

  /// @notice Entry struct storing data and creation timestamp
  struct Entry {
    bytes data;
    uint256 createdAt;
  }

  // Storage

  /// @notice Mapping from user address to (id => Entry)
  mapping(address => mapping(bytes32 => Entry)) internal _entries;

  /// @notice Mapping of used nonces to prevent replay attacks
  mapping(bytes32 => bool) public usedNonces;

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

  /// @notice Constructor
  /// @param admin The admin of the contract
  constructor(address admin) EIP712("RelayGenericMapping", "1") {
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
  }

  /// @notice Set an entry for a user after verifying oracle signature
  /// @param user The user address
  /// @param id The entry identifier
  /// @param data The entry data (arbitrary bytes)
  /// @param nonce Unique nonce to prevent replay attacks
  /// @param oracle The oracle address that signed the request
  /// @param oracleSignature The oracle's EIP-712 signature
  function setEntry(
    address user,
    bytes32 id,
    bytes calldata data,
    bytes32 nonce,
    address oracle,
    bytes calldata oracleSignature
  ) external {
    if (id == bytes32(0)) revert EmptyId();
    if (data.length == 0) revert EmptyData();
    if (_entries[user][id].createdAt > 0) revert EntryAlreadyExists(user, id);
    if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);

    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    bytes32 digest = _hashTypedDataV4(
      keccak256(
        abi.encode(SET_ENTRY_TYPEHASH, user, id, keccak256(data), nonce)
      )
    );

    if (!oracle.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(oracle);
    }

    usedNonces[nonce] = true;
    _entries[user][id] = Entry(data, block.timestamp);
    emit EntrySet(user, id, data);
  }

  /// @notice Delete an entry for a user after verifying oracle signature
  /// @param user The user address
  /// @param id The entry identifier
  /// @param nonce Unique nonce to prevent replay attacks
  /// @param oracle The oracle address that signed the request
  /// @param oracleSignature The oracle's EIP-712 signature
  function deleteEntry(
    address user,
    bytes32 id,
    bytes32 nonce,
    address oracle,
    bytes calldata oracleSignature
  ) external {
    if (id == bytes32(0)) revert EmptyId();
    if (_entries[user][id].createdAt == 0) revert EntryNotFound(user, id);
    if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);

    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    bytes32 digest = _hashTypedDataV4(
      keccak256(abi.encode(DELETE_ENTRY_TYPEHASH, user, id, nonce))
    );

    if (!oracle.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(oracle);
    }

    usedNonces[nonce] = true;
    delete _entries[user][id];
    emit EntryDeleted(user, id);
  }

  /// @notice Get an entry for a user
  /// @param user The user address
  /// @param id The entry identifier
  /// @return data The stored data bytes
  /// @return createdAt The timestamp when the entry was set
  function getEntry(
    address user,
    bytes32 id
  ) external view returns (bytes memory data, uint256 createdAt) {
    Entry storage entry = _entries[user][id];
    return (entry.data, entry.createdAt);
  }
}
