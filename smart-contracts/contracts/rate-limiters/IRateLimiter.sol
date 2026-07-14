// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IRateLimiter
/// @author Relay Protocol
/// @notice Pluggable rate limiter consulted on every FAST_MINT. The oracle passes the token id,
///         gross amount, and opaque `data` that the limiter decodes itself, so a new limiter type
///         needs no RelayOracleV2 / SDK change — it is deployed, added to the oracle's limiter
///         allowlist, and fed its own `data`.
interface IRateLimiter {
  /// @notice Try to consume budget for an at-risk fast deposit; returns whether it was consumed.
  /// @dev MUST NOT revert on a budget rejection — return false so the caller can degrade to slow.
  ///      Fail-closed: an unconfigured/over-budget request returns false.
  /// @param tokenId The token id for the fast mint.
  /// @param amount The gross deposit amount.
  /// @param data Limiter-specific encoded input, constructed off-chain by the oracle
  /// @return consumed True if budget was consumed; false to degrade to slow
  function consume(
    uint256 tokenId,
    uint256 amount,
    bytes calldata data
  ) external returns (bool consumed);
}
