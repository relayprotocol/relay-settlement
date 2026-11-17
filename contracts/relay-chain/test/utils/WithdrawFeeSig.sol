// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Authorization} from "../../contracts/Authorization.sol";
import {Vm} from "forge-std/Vm.sol";
import {
  RelayAllocator,
  WithdrawRequest,
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization
} from "../../contracts/RelayAllocator.sol";

function signWithdrawFee(
  uint256 oracleKey,
  RelayAllocator allocator,
  WithdrawRequest memory request,
  WithdrawFeePayment memory withdrawFeePayment,
  uint256 expiration
) view returns (WithdrawFeePaymentAuthorization memory authorization) {
  Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  (uint8 v, bytes32 r, bytes32 s) = vm.sign(
    oracleKey,
    allocator.hashWithdrawFeePaymentAuthorization(
      request,
      withdrawFeePayment,
      expiration
    )
  );
  return
    WithdrawFeePaymentAuthorization(
      withdrawFeePayment,
      Authorization(expiration, abi.encodePacked(r, s, v))
    );
}
