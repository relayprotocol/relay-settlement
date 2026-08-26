// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IRelayOracleIdempotencySource
/// @author Relay Protocol
/// @notice Read-only interface for legacy oracle contracts whose idempotency keys must be honoured.
interface IRelayOracleIdempotencySource {
  /// @notice Whether an idempotency key has already been executed by this source.
  /// @param idempotencyKey The idempotency key.
  /// @return executed True if the key has already been executed.
  function isExecuted(bytes32 idempotencyKey) external view returns (bool);
}

/// @title RelayOracleIdempotencyStore
/// @author Relay Protocol
/// @notice Shared storage for oracle execution idempotency keys.
/// @dev Oracle versions that should share replay protection must be granted WRITE_ROLE.
contract RelayOracleIdempotencyStore is AccessControl {
  // Events

  /// @notice Emitted when an idempotency key is marked as executed.
  event Executed(bytes32 indexed idempotencyKey, address indexed writer);
  /// @notice Emitted when an external idempotency source is added.
  event SourceAdded(address indexed source);

  // Errors

  error ZeroAddress();
  error AlreadyExecuted(bytes32 idempotencyKey);
  error InvalidSource(address source);
  error SourceAlreadyAdded(address source);
  error TooManySources();

  // Roles

  /// @notice Admin role.
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Role allowed to mark idempotency keys as executed.
  bytes32 public constant WRITE_ROLE = keccak256("WRITE_ROLE");

  // Constants

  /// @notice Maximum number of external idempotency sources checked by `isExecuted`.
  uint256 public constant MAX_SOURCES = 5;

  // Fields

  /// @notice Mapping of idempotency key to execution status written directly to this store.
  mapping(bytes32 => bool) public isStored;

  /// @notice External contracts whose `isExecuted` state is also honoured.
  /// @dev Sources are add-only. Once a source is integrated its historical
  ///      idempotency keys must be honoured for the lifetime of the store:
  ///      removing a source would make any key recorded only in that source
  ///      appear unexecuted again, re-opening a replay window for payloads the
  ///      removed oracle already processed. Decommissioned oracles remain
  ///      deployed and continue answering `isExecuted` for their history.
  address[MAX_SOURCES] public sources;

  /// @notice Number of active external idempotency sources.
  uint8 public sourceCount;

  /// @notice Whether an address is configured as an external idempotency source.
  mapping(address => bool) public isSource;

  // Constructor

  /// @notice Constructor.
  /// @param admin The admin of the contract.
  /// @dev Sources are intentionally configured post-deploy via `addSource` so
  ///      deployment never depends on external source calls.
  constructor(address admin) {
    if (admin == address(0)) {
      revert ZeroAddress();
    }

    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(WRITE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
  }

  // Public methods

  /// @notice Add an external idempotency source.
  /// @param source The source address.
  function addSource(address source) external onlyRole(ADMIN_ROLE) {
    _addSource(source);
  }

  /// @notice Whether an idempotency key has already been executed locally or by a source.
  /// @param idempotencyKey The idempotency key.
  /// @return executed True if the key is executed locally or by any configured source.
  function isExecuted(
    bytes32 idempotencyKey
  ) public view returns (bool executed) {
    if (isStored[idempotencyKey]) {
      return true;
    }

    uint256 count = sourceCount;
    for (uint256 i; i < count; ++i) {
      if (
        IRelayOracleIdempotencySource(sources[i]).isExecuted(idempotencyKey)
      ) {
        return true;
      }
    }

    return false;
  }

  /// @notice Mark an idempotency key as executed.
  /// @param idempotencyKey The idempotency key to mark.
  function markExecuted(
    bytes32 idempotencyKey
  ) external onlyRole(WRITE_ROLE) {
    if (isExecuted(idempotencyKey)) {
      revert AlreadyExecuted(idempotencyKey);
    }

    isStored[idempotencyKey] = true;
    emit Executed(idempotencyKey, msg.sender);
  }

  // Internal methods

  /// @notice Add an external idempotency source without checking caller permissions.
  /// @param source The source address.
  function _addSource(address source) internal {
    if (source == address(0)) {
      revert ZeroAddress();
    }
    if (source == address(this) || source.code.length == 0) {
      revert InvalidSource(source);
    }
    if (isSource[source]) {
      revert SourceAlreadyAdded(source);
    }
    if (sourceCount == MAX_SOURCES) {
      revert TooManySources();
    }

    try IRelayOracleIdempotencySource(source).isExecuted(bytes32(0)) returns (
      bool executed
    ) {
      executed;
    } catch {
      revert InvalidSource(source);
    }

    sources[sourceCount] = source;
    ++sourceCount;
    isSource[source] = true;
    emit SourceAdded(source);
  }
}
