// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayAllocatorBase} from "./RelayAllocator.t.sol";
import {WithdrawRequest} from "../../contracts/RelayAllocator.sol";

struct WithdrawalFeeLimit {
  bytes currency;
  uint256 maxAmount;
}

contract RelayAllocatorLegacySignaturesTest is RelayAllocatorBase {
  function testFuzz_legacyNonExpiringSignedSelectorsAreUnavailable(
    bool withFee
  ) public {
    WithdrawRequest memory r = _request(bytes32(uint256(103)), 1);
    bytes32 requestHash = keccak256(
      abi.encode(
        keccak256(
          "WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)"
        ),
        keccak256(bytes(r.chainId)),
        keccak256(r.depository),
        keccak256(r.currency),
        r.amount,
        keccak256(bytes(r.spenderChainId)),
        keccak256(r.spender),
        keccak256(r.receiver),
        keccak256(r.data),
        r.nonce
      )
    );
    WithdrawalFeeLimit memory limit = WithdrawalFeeLimit("", 0);
    bytes32 structHash = withFee
      ? keccak256(
        abi.encode(
          keccak256(
            "WithdrawRequestWithFee(WithdrawRequest request,WithdrawalFeeLimit feeLimit)WithdrawRequest(string chainId,bytes depository,bytes currency,uint256 amount,string spenderChainId,bytes spender,bytes receiver,bytes data,bytes32 nonce)WithdrawalFeeLimit(bytes currency,uint256 maxAmount)"
          ),
          requestHash,
          keccak256(
            abi.encode(
              keccak256("WithdrawalFeeLimit(bytes currency,uint256 maxAmount)"),
              keccak256(limit.currency),
              limit.maxAmount
            )
          )
        )
      )
      : requestHash;
    (uint8 v, bytes32 sR, bytes32 sS) = vm.sign(
      receiverPk,
      keccak256(abi.encodePacked(hex"1901", allocatorDomain, structHash))
    );
    bytes memory sig = abi.encodePacked(sR, sS, v);
    bytes memory callData = withFee
      ? abi.encodeWithSignature(
        "submitWithdrawRequestWithSignature((string,bytes,bytes,uint256,string,bytes,bytes,bytes,bytes32),(bytes,uint256),bytes)",
        r,
        limit,
        sig
      )
      : abi.encodeWithSignature(
        "submitWithdrawRequestWithSignature((string,bytes,bytes,uint256,string,bytes,bytes,bytes,bytes32),bytes)",
        r,
        sig
      );
    (bool success, ) = address(allocator).call(callData);
    assertFalse(success, "non-expiring signature accepted");
    assertFalse(allocator.usedNonces(keccak256(r.spender), r.nonce));
  }
}
