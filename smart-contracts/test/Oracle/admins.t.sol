// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleBase} from "./OracleBase.sol";

/// @notice Port of test/Oracle/admins.ts.
contract OracleAdminRoleTest is OracleBase {
    function test_adminCanAddAndRemoveAdmins() public {
        bytes32 adminRole = oracle.ADMIN_ROLE();
        address newAdmin = otherAccounts[1];
        address nonAdmin = otherAccounts[0];

        assertTrue(oracle.hasRole(adminRole, admin));

        vm.prank(nonAdmin);
        vm.expectRevert();
        oracle.grantRole(adminRole, newAdmin);

        vm.prank(admin);
        oracle.grantRole(adminRole, newAdmin);
        assertTrue(oracle.hasRole(adminRole, newAdmin));

        vm.prank(nonAdmin);
        vm.expectRevert();
        oracle.revokeRole(adminRole, newAdmin);

        vm.prank(admin);
        oracle.revokeRole(adminRole, newAdmin);
        assertFalse(oracle.hasRole(adminRole, newAdmin));
    }
}
