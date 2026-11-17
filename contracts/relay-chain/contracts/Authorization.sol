// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A signature and its last valid Unix timestamp in seconds.
struct Authorization {
  uint256 expiration;
  bytes signature;
}
