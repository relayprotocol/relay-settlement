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

    function test_plantedOperatorCannotTransferAfterGranterRoleIsRevoked() public {
        vm.startPrank(operatorUser);
        hub.mint(regularUser, 1, 100);
        hub.setOperatorFor(regularUser, operatorAddr, true);
        vm.stopPrank();

        vm.prank(operatorAddr);
        hub.transferFrom(regularUser, operatorAddr, 1, 10);
        assertEq(hub.balanceOf(operatorAddr, 1), 10);

        vm.prank(admin);
        hub.revokeRole(OPERATOR_ROLE, operatorUser);

        vm.prank(operatorAddr);
        vm.expectRevert(); // arithmetic underflow (panic 0x11)
        hub.transferFrom(regularUser, operatorAddr, 1, 10);
    }

    function test_doesNotClearUserSetOperator() public {
        vm.prank(regularUser);
        hub.setOperator(operatorAddr, true);

        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, false);
        assertTrue(hub.isOperator(regularUser, operatorAddr));
    }

    function test_replantingByLiveRoleHolderRestoresGrant() public {
        vm.prank(operatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, true);
        vm.prank(admin);
        hub.revokeRole(OPERATOR_ROLE, operatorUser);
        assertFalse(hub.isOperator(regularUser, operatorAddr));

        address newOperatorUser = otherAccounts[3];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, newOperatorUser);
        vm.prank(newOperatorUser);
        hub.setOperatorFor(regularUser, operatorAddr, true);

        assertTrue(hub.isOperator(regularUser, operatorAddr));
        assertEq(hub.operatorGrantedBy(regularUser, operatorAddr), newOperatorUser);
    }
}
