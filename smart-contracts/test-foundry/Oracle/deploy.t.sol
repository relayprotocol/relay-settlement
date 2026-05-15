// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleBase} from "./OracleBase.sol";

/// @notice Port of test/Oracle/deploy.ts.
contract OracleDeployTest is OracleBase {
    function test_deploysWithCorrectAdminAndHub() public view {
        assertTrue(oracle.hasRole(oracle.ADMIN_ROLE(), admin));
        assertEq(address(oracle.HUB()), address(hub));
    }
}
