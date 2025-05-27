// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";

contract DummyPayloadBuilder is PayloadBuilder {
  function buildPayload(
    uint256,
    address,
    address,
    uint256,
    address,
    bytes calldata
  ) external view override returns (bytes memory) {
    return "dummy payload";
  }

  function hashPayload(
    uint256,
    address,
    bytes calldata payload
  ) external pure override returns (bytes32) {
    return keccak256(payload);
  }
}
