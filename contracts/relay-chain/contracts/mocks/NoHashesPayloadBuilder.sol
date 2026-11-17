// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  IPayloadBuilder,
  WithdrawRequest,
  WithdrawFee
} from "../RelayAllocator.sol";

/// @title NoHashesPayloadBuilder
/// @author Relay Protocol
/// @notice Test helper payload builder that returns a payload but no hashes to sign
contract NoHashesPayloadBuilder is IPayloadBuilder {
  /// @inheritdoc IPayloadBuilder
  function buildPayload(
    string calldata,
    bytes calldata,
    WithdrawRequest calldata
  )
    external
    pure
    returns (bytes memory payload, WithdrawFee memory withdrawFee)
  {
    return (hex"01", withdrawFee);
  }

  /// @inheritdoc IPayloadBuilder
  function hashesToSign(
    string calldata,
    bytes calldata,
    bytes calldata
  ) external pure returns (bytes32[] memory hashes) {
    return hashes;
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure returns (string memory name) {
    return "mock";
  }
}
