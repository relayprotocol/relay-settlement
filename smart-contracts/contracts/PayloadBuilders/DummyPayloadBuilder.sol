// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";

contract DummyPayloadBuilder is PayloadBuilder {
  function buildPayload(
    uint256 /** chainId */,
    string calldata /* escrow */,
    string calldata /* currency */,
    uint256 /* amount */,
    string calldata /* receiver */,
    bytes calldata /* data */
  ) external pure override returns (bytes memory) {
    return "dummy payload";
  }

  function hashesToSign(
    uint256 /** chainId */,
    string calldata /* escrow */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    hashes = new bytes32[](1);
    hashes[0] = keccak256(payload);
    return hashes;
  }

  function curve() external pure returns (string memory) {
    return "dummy curve";
  }

  function family() external pure returns (string memory) {
    return "dummy-vm";
  }
}
