// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/deploy.ts.
contract HubDeploymentTest is HubBase {
    function test_deploysHubContractWithCorrectOperatorAdmin() public view {
        assertTrue(hub.hasRole(ADMIN_ROLE, admin));
    }

    function test_allowsAdminToAddAnAdmin() public {
        assertEq(hub.getRoleAdmin(ADMIN_ROLE), ADMIN_ROLE);
        assertTrue(hub.hasRole(ADMIN_ROLE, admin));

        address anotherAdmin = newOwner;
        vm.prank(admin);
        hub.grantRole(ADMIN_ROLE, anotherAdmin);
        assertTrue(hub.hasRole(ADMIN_ROLE, anotherAdmin));
    }
}
