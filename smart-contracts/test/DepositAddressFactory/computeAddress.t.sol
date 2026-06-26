// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DepositAddressFactoryBase} from "./DepositAddressFactoryBase.sol";

/// @notice Port of test/DepositAddressFactory/computeAddress.ts.
contract DepositAddressFactoryComputeAddressTest is DepositAddressFactoryBase {
    function test_returnsDeterministicAddressForOrderIdAndDepositor() public view {
        address a = factory.computeDepositAddress(orderId, depositor);
        address b = factory.computeDepositAddress(orderId, depositor);
        assertEq(a, b);
    }

    function test_returnsDifferentAddressesForDifferentOrderIds() public view {
        bytes32 orderId1 = keccak256(bytes("order-1"));
        bytes32 orderId2 = keccak256(bytes("order-2"));

        address a = factory.computeDepositAddress(orderId1, depositor);
        address b = factory.computeDepositAddress(orderId2, depositor);
        assertTrue(a != b);
    }

    function test_returnsDifferentAddressesForDifferentDepositors() public view {
        address a = factory.computeDepositAddress(orderId, depositor);
        address b = factory.computeDepositAddress(orderId, anyone);
        assertTrue(a != b);
    }

    function test_returnsNonZeroAddress() public view {
        address a = factory.computeDepositAddress(orderId, depositor);
        assertTrue(a != address(0));
    }
}
