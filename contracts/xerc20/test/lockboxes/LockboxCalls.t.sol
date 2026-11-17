// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {XERC20} from '../../contracts/XERC20.sol';
import {XERC20Factory} from '../../contracts/XERC20Factory.sol';
import {XERC20Lockbox} from '../../contracts/XERC20Lockbox.sol';
import {IXERC20} from '../../interfaces/IXERC20.sol';
import {TestToken} from './TestToken.sol';

/// @dev Test-only generic batch caller. Models calls made by a funded resolver;
/// does not model the external executor's signatures, fees, Hub, or allocator.
contract BatchCaller {
  struct Call {
    address to;
    bytes data;
  }

  function execute(
    Call[] memory calls
  ) external {
    for (uint256 i; i < calls.length; ++i) {
      (bool success, bytes memory result) = calls[i].to.call(calls[i].data);
      if (!success) {
        assembly { revert(add(result, 32), mload(result)) }
      }
    }
  }
}

contract LockboxCallsTest is Test {
  XERC20 internal x;
  BatchCaller internal caller;
  TestToken[] internal tokens;
  address[] internal boxes;
  uint256 internal constant CAPACITY = 1000e6;
  address internal constant RECIPIENT = address(0x5678);

  function setUp() public {
    vm.warp(10 days);
    caller = new BatchCaller();
    XERC20Factory factory = new XERC20Factory();
    x = XERC20(factory.deployXERC20('Internal claim', 'X', new uint256[](0), new uint256[](0), new address[](0)));
    for (uint256 i; i < 6; ++i) {
      tokens.push(new TestToken(6));
      boxes.push(
        i == 5
          ? factory.deployLockbox(address(x), address(tokens[i]), false)
          : address(new XERC20Lockbox(address(x), address(tokens[i]), false))
      );
      if (i != 5) x.setLimits(boxes[i], CAPACITY, CAPACITY);
      tokens[i].mint(address(this), i == 5 ? 9000e6 : 200e6);
      tokens[i].approve(boxes[i], type(uint256).max);
      XERC20Lockbox(payable(boxes[i])).deposit(tokens[i].balanceOf(address(this)));
      // The external executor funds its resolver before invoking the batch.
      tokens[i].mint(address(caller), 10_000e6);
    }
    vm.warp(block.timestamp + 1 days);
  }

  function callsFor(
    uint256 from,
    uint256 to,
    uint256 amount
  ) internal view returns (BatchCaller.Call[] memory calls) {
    calls = new BatchCaller.Call[](4);
    calls[0] = BatchCaller.Call(address(tokens[from]), abi.encodeCall(IERC20.approve, (boxes[from], amount)));
    calls[1] = BatchCaller.Call(boxes[from], abi.encodeCall(XERC20Lockbox.deposit, (amount)));
    calls[2] = BatchCaller.Call(address(x), abi.encodeCall(IERC20.approve, (boxes[to], amount)));
    calls[3] = BatchCaller.Call(boxes[to], abi.encodeCall(XERC20Lockbox.withdrawTo, (RECIPIENT, amount)));
  }

  function swap(
    uint256 from,
    uint256 to,
    uint256 amount
  ) internal {
    caller.execute(callsFor(from, to, amount));
  }

  function testFuzzExactSwapAllPairs(
    uint8 fromSeed,
    uint8 toSeed,
    uint96 amountSeed
  ) public {
    uint256 from = uint256(fromSeed) % 6;
    uint256 to = (from + 1 + uint256(toSeed) % 5) % 6;
    uint256 amount = bound(uint256(amountSeed), 1, 200e6);
    uint256 supply = x.totalSupply();
    uint256 source = tokens[from].balanceOf(boxes[from]);
    uint256 destination = tokens[to].balanceOf(boxes[to]);
    swap(from, to, amount);
    assertEq(tokens[from].balanceOf(address(caller)), 10_000e6 - amount);
    assertEq(tokens[from].balanceOf(boxes[from]), source + amount);
    assertEq(tokens[to].balanceOf(boxes[to]), destination - amount);
    assertEq(tokens[to].balanceOf(RECIPIENT), amount);
    assertEq(x.totalSupply(), supply);
    assertEq(x.balanceOf(address(caller)), 0);
    assertEq(x.allowance(address(caller), boxes[to]), 0);
    assertEq(tokens[from].allowance(address(caller), boxes[from]), 0);
    assertEq(x.mintingMaxLimitOf(address(caller)), 0);
    assertEq(x.burningMaxLimitOf(address(caller)), 0);
  }

  function testSixDecimalRawUnitsDespiteXMetadata() public {
    assertEq(x.decimals(), 18);
    assertEq(tokens[0].decimals(), 6);
    swap(0, 5, 1e6);
    assertEq(tokens[5].balanceOf(RECIPIENT), 1e6);
    assertEq(x.mintingCurrentLimitOf(boxes[0]), CAPACITY - 1e6);
  }

  function testMajorBypassesZeroLimits() public {
    assertEq(x.mintingMaxLimitOf(boxes[5]), 0);
    assertEq(x.burningMaxLimitOf(boxes[5]), 0);
    tokens[5].mint(address(this), 2000e6);
    XERC20Lockbox(payable(boxes[5])).deposit(2000e6);
    x.approve(boxes[5], 2000e6);
    XERC20Lockbox(payable(boxes[5])).withdraw(2000e6);
    assertEq(tokens[5].balanceOf(address(this)), 2000e6);
  }

  function testMinorMintLimitAndRefill() public {
    swap(0, 5, CAPACITY);
    vm.expectRevert(IXERC20.IXERC20_NotHighEnoughLimits.selector);
    swap(0, 5, 1);
    vm.warp(block.timestamp + 1 days);
    swap(0, 5, CAPACITY);
    assertEq(tokens[5].balanceOf(RECIPIENT), 2 * CAPACITY);
  }

  function testMaximumLimitsAllowLargeSwapsAndRefill() public {
    uint256 maximum = type(uint256).max / 2;
    x.setLimits(boxes[0], maximum, maximum);
    uint256 supply = x.totalSupply();
    swap(0, 5, 5000e6);
    swap(5, 0, 5000e6);
    assertEq(tokens[5].balanceOf(RECIPIENT), 5000e6);
    assertEq(tokens[0].balanceOf(RECIPIENT), 5000e6);
    assertEq(x.totalSupply(), supply);
    assertEq(x.mintingCurrentLimitOf(boxes[0]), maximum - 5000e6);
    assertEq(x.burningCurrentLimitOf(boxes[0]), maximum - 5000e6);
    // Maximum-sized buckets must replenish without overflowing arithmetic.
    vm.warp(block.timestamp + 1 days - 1);
    assertEq(x.mintingCurrentLimitOf(boxes[0]), maximum);
    assertEq(x.burningCurrentLimitOf(boxes[0]), maximum);
  }

  function testMinorBurnLimitRollback() public {
    x.setLimits(boxes[0], CAPACITY, 5e6);
    uint256 majorBefore = tokens[5].balanceOf(boxes[5]);
    uint256 supply = x.totalSupply();
    vm.expectRevert(IXERC20.IXERC20_NotHighEnoughLimits.selector);
    swap(5, 0, 6e6);
    assertEq(tokens[5].balanceOf(address(caller)), 10_000e6);
    assertEq(tokens[5].balanceOf(boxes[5]), majorBefore);
    assertEq(x.totalSupply(), supply);
    assertEq(x.balanceOf(address(caller)), 0);
    assertEq(x.burningCurrentLimitOf(boxes[0]), 5e6);
    assertEq(tokens[5].allowance(address(caller), boxes[5]), 0);
  }

  function testPauseMinorBothDirections() public {
    x.setLimits(boxes[0], 0, 0);
    vm.expectRevert(IXERC20.IXERC20_NotHighEnoughLimits.selector);
    swap(0, 5, 1);
    vm.expectRevert(IXERC20.IXERC20_NotHighEnoughLimits.selector);
    swap(5, 0, 1);
    swap(1, 5, 1);
  }

  function testInventoryFailureRollsBackBothLimitsAndMint() public {
    uint256 supply = x.totalSupply();
    vm.expectRevert(bytes('ERC20: transfer amount exceeds balance'));
    swap(0, 1, 201e6);
    assertEq(tokens[0].balanceOf(address(caller)), 10_000e6);
    assertEq(tokens[0].balanceOf(boxes[0]), 200e6);
    assertEq(x.mintingCurrentLimitOf(boxes[0]), CAPACITY);
    assertEq(x.burningCurrentLimitOf(boxes[1]), CAPACITY);
    assertEq(x.totalSupply(), supply);
    assertEq(x.balanceOf(address(caller)), 0);
  }

  function testWithdrawApprovalRequiredAndFailureIsAtomic() public {
    BatchCaller.Call[] memory calls = callsFor(0, 5, 1e6);
    calls[2].data = abi.encodeCall(IERC20.approve, (boxes[5], 0));
    uint256 supply = x.totalSupply();
    vm.expectRevert(bytes('ERC20: insufficient allowance'));
    caller.execute(calls);
    assertEq(tokens[0].balanceOf(address(caller)), 10_000e6);
    assertEq(tokens[0].balanceOf(boxes[0]), 200e6);
    assertEq(x.totalSupply(), supply);
    assertEq(x.balanceOf(address(caller)), 0);
    assertEq(x.mintingCurrentLimitOf(boxes[0]), CAPACITY);
  }
}
