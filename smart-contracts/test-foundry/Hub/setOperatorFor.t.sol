// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/setOperatorFor.ts.
contract HubSetOperatorForTest is HubBase {
    address internal operatorUser;
    address internal regularUser;
    address internal operatorAddr;

    function setUp() public virtual override {
        super.setUp();
        operatorUser = otherAccounts[0];
        regularUser = otherAccounts[1];
        operatorAddr = otherAccounts[2];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
    }

    function test_allowsOperatorToSetOperatorForAnyAddress() public {
        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, true);

        assertTrue(hub.isOperator(regularUser, operatorAddr));
    }

    function test_revertsWhenNonOracleTriesToSetOperator() public {
        vm.prank(regularUser);
        vm.expectRevert();
        hub.setOperatorFor(regularUser, operatorAddr, true);
    }

    function test_allowsOracleToUnsetOperatorByPassingFalseFlag() public {
        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, true);
        assertTrue(hub.isOperator(regularUser, operatorAddr));

        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, false);
        assertFalse(hub.isOperator(regularUser, operatorAddr));
    }
}
