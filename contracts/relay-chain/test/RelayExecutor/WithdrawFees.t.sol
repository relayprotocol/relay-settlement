// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatewayVmPayloadBuilderFeeIntegrationTest} from "../PayloadBuilders/GatewayVmPayloadBuilder.t.sol";
import {
  RelayAllocator,
  WithdrawRequest,
  WithdrawFeePaymentAuthorization
} from "../../contracts/RelayAllocator.sol";
import {RelayExecutor} from "../../contracts/RelayExecutor.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  ExecuteAndWithdrawRequest,
  Fee,
  ICallResolver
} from "../../contracts/call-resolvers/ICallResolver.sol";
import {GatewayVmPayload} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {Utils} from "../../contracts/Utils.sol";

contract VariableOutputResolver is ICallResolver {
  RelayHub private immutable _hub;
  uint256 private immutable _token;

  constructor(RelayHub hub, uint256 token) {
    _hub = hub;
    _token = token;
  }

  function execute(
    ExecuteAndWithdrawRequest calldata,
    bool,
    bytes calldata data
  ) external {
    _hub.transfer(msg.sender, _token, abi.decode(data, (uint256)));
  }
}

contract ExecutorWithdrawFeesTest is GatewayVmPayloadBuilderFeeIntegrationTest {
  RelayExecutor private executor;
  VariableOutputResolver private resolver;
  uint256 private constant ORACLE_KEY = 98765;
  address private oracle;
  address private order;
  address private executorAlias;
  uint256 private inputToken;

  function setUp() public override {
    super.setUp();
    oracle = vm.addr(ORACLE_KEY);
    order = makeAddr("dynamic-swap-order");
    executor = new RelayExecutor(owner, address(hub), address(allocator));
    resolver = new VariableOutputResolver(hub, gatewayTokenId);
    executorAlias = Utils.generateAddress(
      "relay",
      abi.encodePacked(address(executor))
    );
    inputToken = Utils.generateTokenId("source", hex"01");
    bytes32 role = hub.OPERATOR_ROLE();
    bytes32 oracleRole = executor.ORACLE_ROLE();
    vm.startPrank(owner);
    hub.grantRole(role, address(executor));
    executor.grantRole(oracleRole, oracle);
    hub.mint(order, inputToken, 777);
    hub.mint(address(resolver), gatewayTokenId, 10_000_000);
    // Pre-existing executor and alias funds must survive every execution.
    hub.mint(address(executor), gatewayTokenId, 123);
    hub.mint(executorAlias, gatewayTokenId, 456);
    vm.stopPrank();
  }

  function _execution()
    private
    view
    returns (ExecuteAndWithdrawRequest memory request)
  {
    WithdrawRequest memory withdrawal = _withdrawRequest(_params());
    request = ExecuteAndWithdrawRequest({
      inChainId: "source",
      inCurrency: hex"01",
      outChainId: CHAIN_ID,
      outCurrency: withdrawal.currency,
      outAmountMinimum: 900_000,
      depository: gatewayDepository,
      orderAddress: order,
      receiver: withdrawal.receiver,
      data: withdrawal.data,
      fees: new Fee[](0),
      nonce: bytes32(uint256(1)),
      deadline: block.timestamp + 1 hours
    });
  }

  function _signature(
    ExecuteAndWithdrawRequest memory request
  ) private view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(
      ORACLE_KEY,
      executor.hashExecuteAndWithdrawRequest(request)
    );
    return abi.encodePacked(r, s, v);
  }

  function _feeAuth(
    ExecuteAndWithdrawRequest memory request,
    uint256 cap
  ) private view returns (WithdrawFeePaymentAuthorization memory) {
    return
      _withdrawFeePaymentAuthorization(
        WithdrawRequest({
          chainId: request.outChainId,
          depository: request.depository,
          currency: request.outCurrency,
          amount: 0,
          spenderChainId: "relay",
          spender: abi.encodePacked(address(executor)),
          receiver: request.receiver,
          data: request.data,
          nonce: executor.hashExecuteAndWithdrawRequest(request)
        }),
        cap
      );
  }

  function _fundPayer(uint256 amount) private {
    vm.prank(owner);
    hub.mint(feePayerAlias, gatewayTokenId, amount);
  }

  function test_variableOutputIsWithdrawnInFullWithSeparateFee() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    uint256 output = 1_050_051;
    _fundPayer(60_000);
    bytes32 hash = executor.execute(
      request,
      address(resolver),
      abi.encode(output),
      oracle,
      _signature(request),
      _feeAuth(request, 60_000)
    );
    GatewayVmPayload memory payload = abi.decode(
      allocator.payloads(hash),
      (GatewayVmPayload)
    );
    assertEq(payload.burnIntent.spec.value, output);
    assertEq(payload.burnIntent.maxFee, 50_053);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000 - 50_053);
    assertEq(hub.balanceOf(order, gatewayTokenId), 0);
    assertEq(hub.balanceOf(address(executor), gatewayTokenId), 123);
    assertEq(hub.balanceOf(executorAlias, gatewayTokenId), 456);
    assertEq(hub.balanceOf(order, inputToken), 0);
    assertEq(executor.orderAddressByWithdrawRequestHash(hash), order);
  }

  function test_minimumDoesNotIncludeSeparatelyFundedFee() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    request.outAmountMinimum = 1_000_000;
    _fundPayer(50_050);
    bytes32 hash = executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      _signature(request),
      _feeAuth(request, 50_050)
    );
    assertEq(
      abi
        .decode(allocator.payloads(hash), (GatewayVmPayload))
        .burnIntent
        .spec
        .value,
      1_000_000
    );
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 0);
  }

  function test_belowMinimumRollsBackSwapAndFeeAuthorization() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    request.outAmountMinimum = 1_000_001;
    _fundPayer(60_000);
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(request, 60_000);
    bytes memory signature = _signature(request);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InsufficientMinimumAmount.selector,
        gatewayTokenId,
        1_000_000,
        request.outAmountMinimum
      )
    );
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature,
      auth
    );
    _assertRolledBack(request);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000);
  }

  function test_feeAboveOracleCapRollsBackSwap() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    _fundPayer(60_000);
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(request, 50_049);
    bytes memory signature = _signature(request);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeeExceedsLimit.selector,
        50_050,
        50_049
      )
    );
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature,
      auth
    );
    _assertRolledBack(request);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000);
  }

  function test_unfundedFeePayerCannotUseSwapOutputOrPriorBalances() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(request, 60_000);
    bytes memory signature = _signature(request);
    vm.expectRevert();
    vm.prank(makeAddr("first-relayer"));
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature,
      auth
    );
    _assertRolledBack(request);
    _fundPayer(60_000);
    vm.prank(makeAddr("retry-relayer"));
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature,
      auth
    );
    assertEq(hub.balanceOf(executorAlias, gatewayTokenId), 456);
  }

  function test_revealedFeeAuthorizationCannotFundAnotherOrder() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(request, 60_000);
    bytes memory signature = _signature(request);
    // The failed transaction reveals both signatures without consuming them.
    vm.expectRevert();
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature,
      auth
    );
    _assertRolledBack(request);
    _fundPayer(60_000);

    address otherOrder = makeAddr("other-order");
    vm.prank(owner);
    hub.mint(otherOrder, inputToken, 777);
    request.orderAddress = otherOrder;
    // Even a valid oracle signature for a different order cannot reuse the fee
    // authorization, despite identical output fields and original nonce.
    bytes memory otherSignature = _signature(request);
    vm.expectRevert(
      RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
    );
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      otherSignature,
      auth
    );
    _assertRolledBack(request);
    assertEq(hub.balanceOf(otherOrder, inputToken), 777);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000);

    request.orderAddress = order;
    vm.prank(makeAddr("retry-relayer"));
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_001)),
      oracle,
      signature,
      auth
    );
    assertEq(hub.balanceOf(otherOrder, inputToken), 777);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000 - 50_051);
  }

  function test_withdrawFeePaymentAuthorizationBindsExecutionTerms() public {
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(
      _execution(),
      60_000
    );
    _fundPayer(60_000);
    for (uint256 i; i < 3; ++i) {
      ExecuteAndWithdrawRequest memory request = _execution();
      if (i == 0) {
        request.outAmountMinimum += 1;
      } else if (i == 1) {
        request.deadline += 1;
      } else {
        request.fees = new Fee[](1);
        request.fees[0] = Fee(makeAddr("different-fee-recipient"), 1);
      }
      // Authorize the changed execution itself so only the fee binding fails.
      bytes memory signature = _signature(request);
      vm.expectRevert(
        RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
      );
      executor.execute(
        request,
        address(resolver),
        abi.encode(uint256(1_000_000)),
        oracle,
        signature,
        auth
      );
      _assertRolledBack(request);
      assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 60_000);
    }
  }

  function test_sameAuthorizationAcceptsRuntimeOutputButCannotReplay() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    _fundPayer(60_000);
    bytes memory signature = _signature(request);
    WithdrawFeePaymentAuthorization memory auth = _feeAuth(request, 60_000);
    bytes32 hash = executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(2_000_000)),
      oracle,
      signature,
      auth
    );
    GatewayVmPayload memory payload = abi.decode(
      allocator.payloads(hash),
      (GatewayVmPayload)
    );
    assertEq(payload.burnIntent.spec.value, 2_000_000);
    assertEq(payload.burnIntent.maxFee, 50_100);
    bytes32 digest = executor.hashExecuteAndWithdrawRequest(request);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        digest
      )
    );
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(2_000_000)),
      oracle,
      signature,
      auth
    );
  }

  function test_originalExecuteCannotChargeAnUnspecifiedPayer() public {
    ExecuteAndWithdrawRequest memory request = _execution();
    bytes memory signature = _signature(request);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeeExceedsLimit.selector,
        50_050,
        0
      )
    );
    executor.execute(
      request,
      address(resolver),
      abi.encode(uint256(1_000_000)),
      oracle,
      signature
    );
    _assertRolledBack(request);
  }

  function _assertRolledBack(
    ExecuteAndWithdrawRequest memory request
  ) private view {
    assertEq(hub.balanceOf(order, inputToken), 777);
    assertEq(hub.balanceOf(address(resolver), gatewayTokenId), 10_000_000);
    assertEq(hub.balanceOf(address(executor), gatewayTokenId), 123);
    assertEq(hub.balanceOf(executorAlias, gatewayTokenId), 456);
    assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 0);
    assertFalse(
      executor.usedRequests(executor.hashExecuteAndWithdrawRequest(request))
    );
  }
}
