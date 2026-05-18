// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleBase} from "./OracleBase.sol";

/// @notice Port of test/Oracle/addAndRemoveOracles.ts.
contract OracleAddRemoveOraclesTest is OracleBase {
    function test_adminCanAddAndRemoveOracles() public {
        bytes32 oracleRole = oracle.ORACLE_ROLE();
        address nonAdmin = otherAccounts[0];
        address oracleWallet = otherAccounts[1];

        assertFalse(oracle.hasRole(oracleRole, oracleWallet));

        vm.prank(nonAdmin);
        vm.expectRevert();
        oracle.grantRole(oracleRole, oracleWallet);

        vm.prank(admin);
        oracle.grantRole(oracleRole, oracleWallet);
        assertTrue(oracle.hasRole(oracleRole, oracleWallet));

        vm.prank(nonAdmin);
        vm.expectRevert();
        oracle.revokeRole(oracleRole, oracleWallet);

        vm.prank(admin);
        oracle.revokeRole(oracleRole, oracleWallet);
        assertFalse(oracle.hasRole(oracleRole, oracleWallet));
    }
}
