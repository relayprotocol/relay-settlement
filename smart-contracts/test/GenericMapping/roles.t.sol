// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GenericMappingBase} from "./GenericMappingBase.sol";

/// @notice Port of test/GenericMapping/roles.ts.
contract GenericMappingRolesTest is GenericMappingBase {
    function test_adminRoleGrantedToAdmin() public view {
        assertTrue(store.hasRole(store.ADMIN_ROLE(), admin));
    }

    function test_allowsAdminToGrantOracleRole() public {
        bytes32 oracleRole = store.ORACLE_ROLE();
        address newOracle = otherAccounts[1];
        vm.prank(admin);
        store.grantRole(oracleRole, newOracle);
        assertTrue(store.hasRole(oracleRole, newOracle));
    }

    function test_allowsAdminToRevokeOracleRole() public {
        bytes32 oracleRole = store.ORACLE_ROLE();
        vm.prank(admin);
        store.revokeRole(oracleRole, oracle);
        assertFalse(store.hasRole(oracleRole, oracle));
    }

    function test_revertsWhenNonAdminGrantsOracleRole() public {
        bytes32 oracleRole = store.ORACLE_ROLE();
        vm.prank(caller);
        vm.expectRevert();
        store.grantRole(oracleRole, otherAccounts[1]);
    }
}
