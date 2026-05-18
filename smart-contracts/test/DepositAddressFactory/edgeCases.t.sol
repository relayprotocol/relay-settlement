// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {DepositAddressFactoryBase} from "./DepositAddressFactoryBase.sol";
import {DepositAddress} from "../../contracts/deposit-addresses/strict/ethereum/DepositAddress.sol";

/// @notice Port of test/DepositAddressFactory/edgeCases.ts.
contract DepositAddressFactoryEdgeCasesTest is DepositAddressFactoryBase {
    bytes32 private constant ERC20_DEPOSIT_SIG =
        keccak256("RelayErc20Deposit(address,address,uint256,bytes32)");
    bytes32 private constant NATIVE_DEPOSIT_SIG =
        keccak256("RelayNativeDeposit(address,uint256,bytes32)");

    function _countAndLast(
        Vm.Log[] memory logs,
        address emitter,
        bytes32 sig
    ) private pure returns (uint256 count, bytes memory data) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == sig) {
                ++count;
                data = logs[i].data;
            }
        }
    }

    function test_succeedsWhenSweepingTokenWithZeroBalance() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 count, ) = _countAndLast(logs, address(depository), ERC20_DEPOSIT_SIG);
        assertEq(count, 0);
    }

    function test_succeedsWhenSweepingNativeEthWithZeroBalance() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 count, ) = _countAndLast(logs, address(depository), NATIVE_DEPOSIT_SIG);
        assertEq(count, 0);
    }

    function test_acceptsEthAfterDeploymentAntiGriefing() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount = 1 ether;

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        vm.deal(deployer, amount);
        vm.prank(deployer);
        (bool ok, ) = predicted.call{value: amount}("");
        require(ok, "send failed");

        assertEq(predicted.balance, amount);
    }

    function test_doesNotSweepFundsWhenCalledWithWrongDepositor() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        vm.prank(deployer);
        token.transfer(predicted, 500);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        factory.sweep(orderId, anyone, tokens);

        assertEq(token.balanceOf(predicted), 500);
    }

    function test_doesNotAllowFrontRunningToBlockLegitimateSweep() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        vm.prank(deployer);
        token.transfer(predicted, 1000);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        factory.sweep(orderId, anyone, tokens);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 count;
        address fromAddr;
        uint256 amt;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(depository) && logs[i].topics[0] == ERC20_DEPOSIT_SIG) {
                (address from, , uint256 a, ) = abi.decode(
                    logs[i].data,
                    (address, address, uint256, bytes32)
                );
                ++count;
                fromAddr = from;
                amt = a;
            }
        }
        assertEq(count, 1);
        assertEq(fromAddr, depositor);
        assertEq(amt, 1000);
    }

    function test_revertsWhenAttackerCallsProxySweepDirectly() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        vm.prank(deployer);
        token.transfer(predicted, 1000);

        DepositAddress proxy = DepositAddress(payable(predicted));
        vm.prank(anyone);
        vm.expectRevert(DepositAddress.OnlyFactory.selector);
        proxy.sweep(address(token), anyone, orderId);

        assertEq(token.balanceOf(predicted), 1000);
    }

    function test_handlesAddressZeroPassedMultipleTimesInTokensArray() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount = 1 ether;

        vm.deal(predicted, amount);

        address[] memory tokens = new address[](2);
        tokens[0] = address(0);
        tokens[1] = address(0);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 count;
        uint256 lastAmt;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(depository) && logs[i].topics[0] == NATIVE_DEPOSIT_SIG) {
                (, uint256 a, ) = abi.decode(logs[i].data, (address, uint256, bytes32));
                ++count;
                lastAmt = a;
            }
        }
        assertEq(count, 1);
        assertEq(lastAmt, amount);
    }
}
