// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../RelayAllocator.sol";

/// @title DummyPayloadBuilder
/// @author Relay Protocol
/// @notice Dummy implementation for testing purposes
contract DummyPayloadBuilder is IPayloadBuilder {
  /// @notice Returns dummy payload for testing
  /// @return payload "dummy payload" string
  function buildPayload(
    uint256 /** chainId */,
    string calldata /* depository */,
    string calldata /* currency */,
    uint256 /* amount */,
    string calldata /* receiver */,
    bytes calldata /* data */
  ) external pure override returns (bytes memory) {
    return "dummy payload";
  }

  /// @notice Returns single hash for dummy payload
  /// @param payload Payload to hash
  /// @return hashes Array with single keccak256 hash
  function hashToSign(
    uint256 /** chainId */,
    string calldata /* depository */,
    bytes calldata payload,
    uint32 /* hashIndex */
  ) external pure override returns (bytes32) {
    return keccak256(payload);
  }

  /// @notice Returns dummy curve name
  /// @return curve "dummy curve"
  function curve() external pure returns (string memory) {
    return "dummy curve";
  }

  /// @notice Returns dummy family identifier
  /// @return family "dummy-vm"
  function family() external pure returns (string memory) {
    return "dummy-vm";
  }
}
