// SPDX-License-Identifier: MIT
// ABOUTME: Interface for the DepositAddressFactory contract.
// ABOUTME: Defines the API for deterministic deposit address computation and sweeping.
pragma solidity ^0.8.28;

/// @title IDepositAddressFactory
/// @author Relay Protocol
/// @notice Interface for deterministic deposit address computation and fund sweeping
interface IDepositAddressFactory {
  /// @notice Emitted when a new proxy is deployed for an order
  event ProxyDeployed(bytes32 indexed orderId, address proxyAddress);

  /// @notice Compute the deterministic deposit address for an order and depositor
  /// @param orderId The unique order identifier
  /// @param depositor The depositor address credited in the depository
  /// @return The predicted proxy address
  function computeDepositAddress(
    bytes32 orderId,
    address depositor
  ) external view returns (address);

  /// @notice Deploy proxy (if needed) and sweep tokens to the depository
  /// @param orderId The unique order identifier used as CREATE2 salt
  /// @param depositor The address to credit in the depository
  /// @param tokens Token addresses to sweep (address(0) for native ETH)
  function sweep(
    bytes32 orderId,
    address depositor,
    address[] calldata tokens
  ) external;
}
