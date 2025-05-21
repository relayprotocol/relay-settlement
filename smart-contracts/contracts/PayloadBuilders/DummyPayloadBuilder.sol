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
  ) external pure override returns (bytes memory) {
    return "dummy payload";
  }
}
