// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVerifierProxy} from "../price-adapters/ChainlinkDataStreamsAdapter.sol";

/// @title MockVerifierProxy
/// @author Relay Protocol
/// @notice Test helper that mimics Chainlink's `VerifierProxy.verify` by
///         unwrapping the `fullReport` envelope and returning the decoded
///         report body, without checking DON signatures or charging a fee.
contract MockVerifierProxy is IVerifierProxy {
  /// @inheritdoc IVerifierProxy
  function verify(
    bytes calldata payload,
    bytes calldata
  ) external payable returns (bytes memory verifierResponse) {
    (, verifierResponse, , , ) = abi.decode(
      payload,
      (bytes32[3], bytes, bytes32[], bytes32[], bytes32)
    );
  }
}
