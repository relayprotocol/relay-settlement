// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Test fixture for legacy oracle idempotency sources.
contract MockRelayOracleIdempotencySource {
  mapping(bytes32 => bool) public isExecuted;

  function setExecuted(bytes32 idempotencyKey, bool executed) external {
    isExecuted[idempotencyKey] = executed;
  }
}
