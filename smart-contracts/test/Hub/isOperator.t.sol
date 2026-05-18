// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/isOperator.ts.
contract HubIsOperatorReturnsTrueTest is HubBase {
    address internal operatorUser;
    address internal regularUser;

    function setUp() public virtual override {
        super.setUp();
        operatorUser = otherAccounts[1];
        regularUser = otherAccounts[0];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
    }

    function test_whenOperatorHasOperatorRole() public view {
        assertTrue(hub.isOperator(regularUser, operatorUser));
    }

    function test_whenOperatorIsSet() public {
        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorUser, true);
        assertTrue(hub.isOperator(regularUser, operatorUser));
    }

    function test_whenOperatorIsSelf_returnsFalse() public view {
        assertFalse(hub.isOperator(regularUser, regularUser));
    }
}

contract HubIsOperatorReturnsFalseTest is HubBase {
    address internal operatorUser;
    address internal regularUser;
    address internal anotherUserToBeOperator;

    function setUp() public virtual override {
        super.setUp();
        regularUser = otherAccounts[0];
        operatorUser = otherAccounts[1];
        anotherUserToBeOperator = otherAccounts[2];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
    }

    function test_whenOperatorIsNotSet() public view {
        assertFalse(hub.isOperator(regularUser, anotherUserToBeOperator));
    }

    function test_whenOperatorIsUnset() public {
        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, anotherUserToBeOperator, false);
        assertFalse(hub.isOperator(regularUser, anotherUserToBeOperator));
    }
}
