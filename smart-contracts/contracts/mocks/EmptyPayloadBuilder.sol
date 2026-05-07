// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";

/// @title EmptyPayloadBuilder
/// @author Relay Protocol
/// @notice Test helper payload builder that always returns an empty payload
contract EmptyPayloadBuilder is IPayloadBuilder {
  /// @inheritdoc IPayloadBuilder
  function buildPayload(
    string calldata,
    bytes calldata,
    BuildPayloadParams calldata
  ) external pure returns (bytes memory payload) {
    return payload;
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
