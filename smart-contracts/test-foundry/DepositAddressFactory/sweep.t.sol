// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {DepositAddressFactoryBase} from "./DepositAddressFactoryBase.sol";
import {IDepositAddressFactory} from "../../contracts/deposit-addresses/strict/ethereum/IDepositAddressFactory.sol";

/// @notice Port of test/DepositAddressFactory/sweep.ts.
contract DepositAddressFactorySweepFirstSweepTest is DepositAddressFactoryBase {
    function test_deploysProxyAtPreComputedAddress() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        address[] memory tokens = new address[](0);

        factory.sweep(orderId, depositor, tokens);

        assertGt(predicted.code.length, 0);
    }

    function test_emitsProxyDeployedEvent() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        address[] memory tokens = new address[](0);

        vm.expectEmit(true, true, true, true, address(factory));
        emit IDepositAddressFactory.ProxyDeployed(orderId, predicted);
        factory.sweep(orderId, depositor, tokens);
    }

    function test_sweepsErc20TokensSentToPreComputedAddress() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount = 1000;

        vm.prank(deployer);
        token.transfer(predicted, amount);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(token.balanceOf(address(depository)), amount);

        uint256 erc20DepositCount;
        bytes32 sig = keccak256("RelayErc20Deposit(address,address,uint256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(depository) && logs[i].topics[0] == sig) {
                (address from, , uint256 amt, bytes32 id) = abi.decode(
                    logs[i].data,
                    (address, address, uint256, bytes32)
                );
                ++erc20DepositCount;
                assertEq(from, depositor);
                assertEq(amt, amount);
                assertEq(id, orderId);
            }
        }
        assertEq(erc20DepositCount, 1);
    }

    function test_sweepsNativeEthSentToPreComputedAddress() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount = 1 ether;

        vm.deal(predicted, amount);

        address[] memory tokens = new address[](1);
        tokens[0] = address(0);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 nativeDepositCount;
        bytes32 sig = keccak256("RelayNativeDeposit(address,uint256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(depository) && logs[i].topics[0] == sig) {
                (address from, uint256 amt, bytes32 id) = abi.decode(
                    logs[i].data,
                    (address, uint256, bytes32)
                );
                ++nativeDepositCount;
                assertEq(from, depositor);
                assertEq(amt, amount);
                assertEq(id, orderId);
            }
        }
        assertEq(nativeDepositCount, 1);
    }

    function test_sweepsMultipleTokensInSingleCall() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 erc20Amount = 500;
        uint256 ethAmount = 0.5 ether;

        vm.prank(deployer);
        token.transfer(predicted, erc20Amount);
        vm.deal(predicted, ethAmount);

        address[] memory tokens = new address[](2);
        tokens[0] = address(token);
        tokens[1] = address(0);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 erc20Count;
        uint256 nativeCount;
        uint256 erc20Amt;
        uint256 nativeAmt;
        bytes32 erc20Sig = keccak256("RelayErc20Deposit(address,address,uint256,bytes32)");
        bytes32 nativeSig = keccak256("RelayNativeDeposit(address,uint256,bytes32)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(depository)) continue;
            if (logs[i].topics[0] == erc20Sig) {
                (, , uint256 amt, ) = abi.decode(logs[i].data, (address, address, uint256, bytes32));
                ++erc20Count;
                erc20Amt = amt;
            } else if (logs[i].topics[0] == nativeSig) {
                (, uint256 amt, ) = abi.decode(logs[i].data, (address, uint256, bytes32));
                ++nativeCount;
                nativeAmt = amt;
            }
        }
        assertEq(erc20Count, 1);
        assertEq(erc20Amt, erc20Amount);
        assertEq(nativeCount, 1);
        assertEq(nativeAmt, ethAmount);
    }

    function test_correctlyAttributesDepositorAddress() public {
        address predicted = factory.computeDepositAddress(orderId, anyone);
        uint256 amount = 100;

        vm.prank(deployer);
        token.transfer(predicted, amount);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.recordLogs();
        factory.sweep(orderId, anyone, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("RelayErc20Deposit(address,address,uint256,bytes32)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(depository) && logs[i].topics[0] == sig) {
                (address from, , , ) = abi.decode(logs[i].data, (address, address, uint256, bytes32));
                assertEq(from, anyone);
                found = true;
            }
        }
        assertTrue(found);
    }
}

contract DepositAddressFactorySweepReSweepTest is DepositAddressFactoryBase {
    function test_sweepsErc20FromAlreadyDeployedProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount1 = 500;
        uint256 amount2 = 300;

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.prank(deployer);
        token.transfer(predicted, amount1);
        factory.sweep(orderId, depositor, tokens);

        vm.prank(deployer);
        token.transfer(predicted, amount2);
        factory.sweep(orderId, depositor, tokens);

        assertEq(token.balanceOf(address(depository)), amount1 + amount2);
    }

    function test_sweepsNativeEthFromAlreadyDeployedProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        uint256 amount1 = 1 ether;
        uint256 amount2 = 0.5 ether;

        address[] memory tokens = new address[](1);
        tokens[0] = address(0);

        vm.deal(predicted, amount1);
        factory.sweep(orderId, depositor, tokens);

        vm.deal(predicted, amount2);
        factory.sweep(orderId, depositor, tokens);

        assertEq(address(depository).balance, amount1 + amount2);
    }

    function test_doesNotEmitProxyDeployedOnResweep() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        vm.prank(deployer);
        token.transfer(predicted, 100);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.recordLogs();
        factory.sweep(orderId, depositor, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("ProxyDeployed(bytes32,address)");
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == sig) {
                ++count;
            }
        }
        assertEq(count, 0);
    }
}
