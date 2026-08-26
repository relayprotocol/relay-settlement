// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Call} from "./RelayDepositoryStructs.sol";

/// @notice An allocator-authorized Gateway withdrawal
/// @param transferSpecHash Circle transfer-spec hash that must be consumed by the mint
/// @param calls Array of Call structures to execute after the Gateway mint
/// @param nonce Unique request nonce
/// @param expiration Unix timestamp after which the request is invalid
struct CallRequest {
  bytes32 transferSpecHash;
  Call[] calls;
  uint256 nonce;
  uint256 expiration;
}
