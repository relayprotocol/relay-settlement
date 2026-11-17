// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PriceOraclePrecompile
/// @author Relay Protocol
/// @notice Library that wraps the Relay price oracle precompile.
library PriceOraclePrecompile {
  /// @notice Address the price-oracle precompile registers at in the rollup.
  address internal constant PRECOMPILE = address(uint160(0x010002));

  /// @notice Thrown when the precompile call fails or returns no payload.
  error PriceFeedCallFailed();

  /// @notice Returns the latest raw signed update for `(providerId, feedId)`.
  /// @dev Reverts if the precompile rejects the call (e.g. unknown feed) or returns an empty payload.
  /// @param providerId Oracle provider identifier.
  /// @param feedId Provider-specific feed identifier.
  /// @return bytes Opaque provider-signed payload bytes.
  function getFeedUpdate(
    bytes32 providerId,
    bytes32 feedId
  ) internal view returns (bytes memory) {
    bytes memory input = abi.encodePacked(providerId, feedId);
    (bool ok, bytes memory out) = PRECOMPILE.staticcall(input);
    if (!ok || out.length == 0) revert PriceFeedCallFailed();
    return out;
  }
}
