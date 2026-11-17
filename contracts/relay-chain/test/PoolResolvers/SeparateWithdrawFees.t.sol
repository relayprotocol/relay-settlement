// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolDrawResolverTest} from "./PoolDrawResolver.t.sol";
import {FixedWithdrawFeeBuilder} from "../RelayAllocator/WithdrawFees.t.sol";
import {
  WithdrawRequest,
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {ExecuteAndWithdrawRequest} from "../../contracts/call-resolvers/ICallResolver.sol";
import {Call} from "../../contracts/call-resolvers/ResolverSandbox.sol";
import {Utils} from "../../contracts/Utils.sol";
import {signWithdrawFee} from "../utils/WithdrawFeeSig.sol";

contract SeparateWithdrawFeePoolTest is PoolDrawResolverTest {
  function _feeOrder(
    uint256 feeFunds,
    uint256 feeCap
  )
    internal
    returns (
      ExecuteAndWithdrawRequest memory request,
      WithdrawFeePaymentAuthorization memory auth,
      address payerAlias
    )
  {
    FixedWithdrawFeeBuilder builder = new FixedWithdrawFeeBuilder(
      outCurrency,
      2,
      false
    );
    address payer = makeAddr("separate-pool-fee-payer");
    payerAlias = Utils.generateAddress("relay", abi.encodePacked(payer));
    vm.startPrank(owner);
    allocator.setPayloadBuilder(
      OUT_CHAIN_ID,
      abi.encodePacked(depository),
      address(builder)
    );
    hub.mint(otherAccounts[3], tokenInId, 100);
    hub.mint(payerAlias, tokenOutId, feeFunds);
    vm.stopPrank();
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 120);
    request = _request(
      otherAccounts[3],
      100,
      _prepareWithSurplusRecipient(
        otherAccounts[3],
        legs0(),
        calls,
        bytes32(uint256(13)),
        address(pool),
        platform
      )
    );
    WithdrawRequest memory withdrawal = WithdrawRequest(
      OUT_CHAIN_ID,
      request.depository,
      request.outCurrency,
      0,
      "relay",
      abi.encodePacked(address(executor)),
      request.receiver,
      request.data,
      executor.hashExecuteAndWithdrawRequest(request)
    );
    auth = signWithdrawFee(
      oracleSignerPk,
      allocator,
      withdrawal,
      WithdrawFeePayment(
        "relay",
        abi.encodePacked(payer),
        request.outCurrency,
        feeCap
      ),
      block.timestamp + 1 hours
    );
    // This base fixture uses a dummy oracle address; emulate its ERC-1271 verification for this exact digest.
    vm.etch(allocator.ORACLE_MULTISIG(), hex"00");
    vm.mockCall(
      allocator.ORACLE_MULTISIG(),
      abi.encodeWithSelector(
        bytes4(0x1626ba7e),
        allocator.hashWithdrawFeePaymentAuthorization(
          withdrawal,
          auth.withdrawFeePayment,
          auth.authorization.expiration
        ),
        auth.authorization.signature
      ),
      abi.encode(bytes4(0x1626ba7e))
    );
  }
  function test_surplusIsNotReducedBySeparatePayerFee() public {
    (
      ExecuteAndWithdrawRequest memory request,
      WithdrawFeePaymentAuthorization memory auth,
      address payerAlias
    ) = _feeOrder(2, 2);
    bytes32 hash = executor.execute(
      request,
      address(drawResolver),
      preparedPayload,
      oracleSigner,
      _signRequest(request),
      auth
    );
    assertEq(abi.decode(allocator.payloads(hash), (uint256)), 100);
    assertEq(pool.balances(platform, tokenOutView), 1020);
    assertEq(hub.balanceOf(payerAlias, tokenOutId), 0);
    assertEq(hub.balanceOf(address(executor), tokenOutId), 0);
  }
  function test_unfundedPayerRollsBackSurplusCredit() public {
    (
      ExecuteAndWithdrawRequest memory request,
      WithdrawFeePaymentAuthorization memory auth,

    ) = _feeOrder(0, 2);
    bytes memory signature = _signRequest(request);
    vm.expectRevert();
    executor.execute(
      request,
      address(drawResolver),
      preparedPayload,
      oracleSigner,
      signature,
      auth
    );
    assertEq(pool.balances(platform, tokenOutView), 1000);
    assertEq(hub.balanceOf(request.orderAddress, tokenInId), 100);
    assertFalse(
      executor.usedRequests(executor.hashExecuteAndWithdrawRequest(request))
    );
  }
}
