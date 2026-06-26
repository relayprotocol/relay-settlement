// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IRelayAllocatorOwner
/// @author Relay Protocol
/// @notice Minimal interface for reading the allocator owner
interface IRelayAllocatorOwner {
  /// @notice Returns the current owner of the allocator contract
  /// @return account Owner address
  function owner() external view returns (address account);
}

/// @title Config
/// @author Relay Protocol
/// @notice Bytes32 to bytes32 configuration store managed by the RelayAllocator owner
contract Config {
  /// @notice RelayAllocator contract whose owner administers this config
  address public allocator;

  /// @notice Mapping of config keys to stored values
  mapping(bytes32 => bytes32) private values;

  /// @notice Tracks whether a config key has been explicitly set
  mapping(bytes32 => bool) private valueExists;

  /// @notice Emitted when the allocator is set
  /// @param allocator RelayAllocator contract address
  event AllocatorSet(address indexed allocator);

  /// @notice Emitted when a config value is set
  /// @param key Config key
  /// @param value Config value
  event ConfigValueSet(bytes32 indexed key, bytes32 value);

  /// @notice Thrown when a caller is not the current allocator owner
  /// @param account Caller address
  error CallerIsNotAllocatorOwner(address account);

  /// @notice Thrown when attempting to set an invalid allocator contract
  /// @param allocator Proposed allocator address
  error InvalidAllocator(address allocator);

  /// @notice Thrown when attempting to read a config key that has not been set
  /// @param key Config key
  error ConfigValueNotSet(bytes32 key);

  /// @notice Thrown when batch input arrays do not have the same length
  /// @param keysLength Number of keys provided
  /// @param valuesLength Number of values provided
  error ArrayLengthMismatch(uint256 keysLength, uint256 valuesLength);

  /// @notice Creates a new config store
  /// @param _allocator RelayAllocator contract address
  constructor(address _allocator) {
    _validateAllocator(_allocator);
    allocator = _allocator;
    emit AllocatorSet(_allocator);
  }

  /// @notice Restricts access to the current owner of the allocator contract
  modifier onlyAllocatorOwner() {
    if (msg.sender != IRelayAllocatorOwner(allocator).owner()) {
      revert CallerIsNotAllocatorOwner(msg.sender);
    }
    _;
  }

  /// @notice Updates the allocator contract that administers this config
  /// @param newAllocator New RelayAllocator contract address
  function setAllocator(address newAllocator) external onlyAllocatorOwner {
    _validateAllocator(newAllocator);
    allocator = newAllocator;
    emit AllocatorSet(newAllocator);
  }

  /// @notice Validates that an allocator address is non-zero and exposes a non-zero owner
  /// @param newAllocator Proposed allocator address
  function _validateAllocator(address newAllocator) internal view {
    if (newAllocator == address(0)) {
      revert InvalidAllocator(newAllocator);
    }

    try IRelayAllocatorOwner(newAllocator).owner() returns (address account) {
      if (account == address(0)) {
        revert InvalidAllocator(newAllocator);
      }
    } catch {
      revert InvalidAllocator(newAllocator);
    }
  }

  /// @notice Sets a config value for a key
  /// @param key Config key
  /// @param value Config value
  function setConfigValue(
    bytes32 key,
    bytes32 value
  ) external onlyAllocatorOwner {
    values[key] = value;
    valueExists[key] = true;
    emit ConfigValueSet(key, value);
  }

  /// @notice Sets multiple config values
  /// @param keys Config keys
  /// @param newValues Config values
  function setConfigValues(
    bytes32[] calldata keys,
    bytes32[] calldata newValues
  ) external onlyAllocatorOwner {
    if (keys.length != newValues.length) {
      revert ArrayLengthMismatch(keys.length, newValues.length);
    }

    for (uint256 i; i < keys.length; ++i) {
      values[keys[i]] = newValues[i];
      valueExists[keys[i]] = true;
      emit ConfigValueSet(keys[i], newValues[i]);
    }
  }

  /// @notice Returns a config value for a key and reverts if it is not set
  /// @param key Config key
  /// @return value Config value
  function getConfigValue(bytes32 key) external view returns (bytes32 value) {
    if (!valueExists[key]) {
      revert ConfigValueNotSet(key);
    }

    return values[key];
  }
}
