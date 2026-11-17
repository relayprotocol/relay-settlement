// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {
  IPayloadBuilder,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";

/// @notice Extracts the payload for existing serialization and signing tests.
function buildPayloadOnly(
  IPayloadBuilder builder,
  string memory chainId,
  bytes memory depository,
  WithdrawRequest memory request
) view returns (bytes memory payload) {
  (payload, ) = builder.buildPayload(chainId, depository, request);
}
