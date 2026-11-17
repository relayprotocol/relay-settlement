// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/addOracle.ts (covers role wiring).
contract HubAddOracleConstructorTest is HubBase {
    function test_setsTheOperatorAdminCorrectly() public view {
        assertTrue(hub.hasRole(ADMIN_ROLE, admin));
    }
}

contract HubAddingRemovingOraclesTest is HubBase {
    function test_canBeDoneByAdmin() public {
        address operatorUser = otherAccounts[0];
        assertFalse(hub.hasRole(OPERATOR_ROLE, operatorUser));

        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
        assertTrue(hub.hasRole(OPERATOR_ROLE, operatorUser));

        vm.prank(admin);
        hub.revokeRole(OPERATOR_ROLE, operatorUser);
        assertFalse(hub.hasRole(OPERATOR_ROLE, operatorUser));
    }

    function test_revertsIfCalledByNonAdmin() public {
        address attacker = otherAccounts[1];
        vm.prank(attacker);
        vm.expectRevert();
        hub.grantRole(OPERATOR_ROLE, attacker);
    }
}
