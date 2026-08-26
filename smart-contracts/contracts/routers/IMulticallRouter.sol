// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A structure representing a single call to be executed by a router
/// @param to The target contract address to call
/// @param data The calldata to send to the target
/// @param value The amount of native currency to send with the call
/// @param allowFailure Whether the call is allowed to fail without reverting the entire execution
struct Call {
  address to;
  bytes data;
  uint256 value;
  bool allowFailure;
}

/// @title IMulticallRouter
/// @author Relay Protocol
/// @notice Standard multicall interface implemented by every allowlisted router
/// @dev The interface does not express access control, but every implementation
/// must restrict `multicall` to its authorized RelayDepository address(es)
interface IMulticallRouter {
  /// @notice Execute a list of calls from the router's context
  /// @param calls The calls to execute, in order
  function multicall(Call[] calldata calls) external payable;
}
