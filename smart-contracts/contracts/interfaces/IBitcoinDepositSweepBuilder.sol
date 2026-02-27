// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBitcoinDepositSweepBuilder
/// @author Relay Protocol
/// @notice Interface for building Bitcoin sweep transaction payloads
interface IBitcoinDepositSweepBuilder {
  /// @notice Builds a sweep payload from opaque data
  /// @param orderId The 32-byte order identifier
  /// @param data Builder-specific encoded parameters
  /// @return payload ABI-encoded BitcoinTransactionData
  /// @return sweepAmount The amount being swept to the depository
  function buildSweepPayload(
    bytes32 orderId,
    bytes calldata data
  ) external view returns (bytes memory payload, uint64 sweepAmount);

  /// @notice Returns the hash that needs to be signed for the payload
  /// @param payload The payload returned by buildSweepPayload
  /// @return The hash to sign
  function hashToSign(bytes calldata payload) external pure returns (bytes32);
}
