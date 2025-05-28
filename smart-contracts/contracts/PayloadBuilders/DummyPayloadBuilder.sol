// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";

contract DummyPayloadBuilder is PayloadBuilder {
  function buildPayload(
    uint256 /** chainId */,
    address /* escrow */,
    string calldata /* currency */,
    uint256 /* amount */,
    string calldata /* receiver */,
    bytes calldata /* data */
  ) external view override returns (bytes memory) {
    return "dummy payload";
  }

  function hashPayload(
    uint256 /** chainId */,
    address /* escrow */,
    bytes calldata payload
  ) external pure override returns (bytes32) {
    return keccak256(payload);
  }
}
