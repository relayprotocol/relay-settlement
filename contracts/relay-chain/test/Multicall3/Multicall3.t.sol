// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {Multicall3} from "../../contracts/Multicall3.sol";

contract Multicall3Target {
  error TargetError(uint256 code);

  uint256 public callCount;
  uint256 public valueReceived;

  function succeed(uint256 value) external payable returns (uint256) {
    ++callCount;
    valueReceived += msg.value;
    return value;
  }

  function fail() external payable {
    revert TargetError(42);
  }

  function failWithoutData() external pure {
    assembly ("memory-safe") {
      revert(0, 0)
    }
  }
}

contract Multicall3Test is Test {
  Multicall3 internal multicall;
  Multicall3Target internal target;

  function setUp() public {
    multicall = new Multicall3();
    target = new Multicall3Target();
  }

  function testAggregateBubblesRevertData() public {
    Multicall3.Call[] memory calls = _requiredFailure();

    vm.expectRevert(
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    multicall.aggregate(calls);
  }

  function testAggregateReturnsBlockNumberAndCallResults() public {
    Multicall3.Call[] memory calls = new Multicall3.Call[](1);
    calls[0] = Multicall3.Call({
      target: address(target),
      callData: abi.encodeCall(Multicall3Target.succeed, (7))
    });

    (uint256 blockNumber, bytes[] memory results) = multicall.aggregate(calls);

    assertEq(blockNumber, block.number);
    assertEq(abi.decode(results[0], (uint256)), 7);
  }

  function testTryAggregateBubblesRevertDataWhenSuccessIsRequired() public {
    Multicall3.Call[] memory calls = _requiredFailure();

    vm.expectRevert(
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    multicall.tryAggregate(true, calls);
  }

  function testBlockAndAggregateBubblesRevertData() public {
    Multicall3.Call[] memory calls = _requiredFailure();

    vm.expectRevert(
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    multicall.blockAndAggregate(calls);
  }

  function testAggregate3BubblesRevertDataWhenFailureIsDisallowed() public {
    Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
    calls[0] = Multicall3.Call3({
      target: address(target),
      allowFailure: false,
      callData: abi.encodeCall(Multicall3Target.fail, ())
    });

    vm.expectRevert(
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    multicall.aggregate3(calls);
  }

  function testAggregate3ValueBubblesRevertDataWhenFailureIsDisallowed()
    public
  {
    Multicall3.Call3Value[] memory calls = new Multicall3.Call3Value[](1);
    calls[0] = Multicall3.Call3Value({
      target: address(target),
      allowFailure: false,
      value: 1 ether,
      callData: abi.encodeCall(Multicall3Target.fail, ())
    });

    vm.expectRevert(
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    multicall.aggregate3Value{value: 1 ether}(calls);
  }

  function testAllowedFailuresReturnOriginalRevertData() public {
    Multicall3.Call3[] memory calls = new Multicall3.Call3[](2);
    calls[0] = Multicall3.Call3({
      target: address(target),
      allowFailure: true,
      callData: abi.encodeCall(Multicall3Target.fail, ())
    });
    calls[1] = Multicall3.Call3({
      target: address(target),
      allowFailure: false,
      callData: abi.encodeCall(Multicall3Target.succeed, (7))
    });

    Multicall3.Result[] memory results = multicall.aggregate3(calls);

    assertFalse(results[0].success);
    assertEq(
      results[0].returnData,
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
    assertTrue(results[1].success);
    assertEq(abi.decode(results[1].returnData, (uint256)), 7);
    assertEq(target.callCount(), 1);
  }

  function testTryAggregateReturnsFailuresWhenSuccessIsNotRequired() public {
    Multicall3.Result[] memory results = multicall.tryAggregate(
      false,
      _requiredFailure()
    );

    assertFalse(results[0].success);
    assertEq(
      results[0].returnData,
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
  }

  function testAggregate3ValueAllowsConfiguredFailures() public {
    Multicall3.Call3Value[] memory calls = new Multicall3.Call3Value[](1);
    calls[0] = Multicall3.Call3Value({
      target: address(target),
      allowFailure: true,
      value: 1 ether,
      callData: abi.encodeCall(Multicall3Target.fail, ())
    });

    Multicall3.Result[] memory results = multicall.aggregate3Value{
      value: 1 ether
    }(calls);

    assertFalse(results[0].success);
    assertEq(
      results[0].returnData,
      abi.encodeWithSelector(Multicall3Target.TargetError.selector, 42)
    );
  }

  function testAggregate3ValueForwardsExactValues() public {
    Multicall3.Call3Value[] memory calls = new Multicall3.Call3Value[](2);
    calls[0] = Multicall3.Call3Value({
      target: address(target),
      allowFailure: false,
      value: 1 ether,
      callData: abi.encodeCall(Multicall3Target.succeed, (1))
    });
    calls[1] = Multicall3.Call3Value({
      target: address(target),
      allowFailure: false,
      value: 2 ether,
      callData: abi.encodeCall(Multicall3Target.succeed, (2))
    });

    Multicall3.Result[] memory results = multicall.aggregate3Value{
      value: 3 ether
    }(calls);

    assertTrue(results[0].success);
    assertTrue(results[1].success);
    assertEq(target.valueReceived(), 3 ether);
  }

  function testAggregate3ValueRejectsValueMismatch() public {
    Multicall3.Call3Value[] memory calls = new Multicall3.Call3Value[](1);
    calls[0] = Multicall3.Call3Value({
      target: address(target),
      allowFailure: false,
      value: 1 ether,
      callData: abi.encodeCall(Multicall3Target.succeed, (1))
    });

    vm.expectRevert("Multicall3: value mismatch");
    multicall.aggregate3Value{value: 2 ether}(calls);
  }

  function testBlockAndChainGetters() public {
    address coinbase = makeAddr("coinbase");
    address account = makeAddr("account");
    bytes32 previousBlockHash = keccak256("previous-block");
    bytes32 prevrandao = keccak256("prevrandao");
    vm.roll(100);
    vm.setBlockhash(99, previousBlockHash);
    vm.coinbase(coinbase);
    vm.prevrandao(prevrandao);
    vm.warp(1_700_000_000);
    vm.fee(123);
    vm.chainId(537_713);
    vm.deal(account, 4 ether);

    assertEq(multicall.getBlockHash(99), previousBlockHash);
    assertEq(multicall.getBlockNumber(), block.number);
    assertEq(multicall.getCurrentBlockCoinbase(), coinbase);
    assertEq(multicall.getCurrentBlockDifficulty(), uint256(prevrandao));
    assertEq(multicall.getCurrentBlockGasLimit(), block.gaslimit);
    assertEq(multicall.getCurrentBlockTimestamp(), block.timestamp);
    assertEq(multicall.getEthBalance(account), 4 ether);
    assertEq(multicall.getLastBlockHash(), previousBlockHash);
    assertEq(multicall.getBasefee(), block.basefee);
    assertEq(multicall.getChainId(), block.chainid);
  }

  function testEmptyRevertDataIsPassedThrough() public {
    Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
    calls[0] = Multicall3.Call3({
      target: address(target),
      allowFailure: false,
      callData: abi.encodeCall(Multicall3Target.failWithoutData, ())
    });

    (bool success, bytes memory returnData) = address(multicall).call(
      abi.encodeCall(Multicall3.aggregate3, (calls))
    );

    assertFalse(success);
    assertEq(returnData.length, 0);
  }

  function _requiredFailure()
    internal
    view
    returns (Multicall3.Call[] memory calls)
  {
    calls = new Multicall3.Call[](1);
    calls[0] = Multicall3.Call({
      target: address(target),
      callData: abi.encodeCall(Multicall3Target.fail, ())
    });
  }
}
