// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {console} from "forge-std/console.sol";

import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Grants an AccessControl role on the target contract. Replaces the
/// legacy `yarn hardhat grant-role` task.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required, must be admin of the role)
///   CONTRACT             – required, target contract with AccessControl
///   ROLE                 – required, role name (e.g. "ORACLE_ROLE") or
///                          0x-prefixed bytes32 hash
///   ACCOUNT              – required, address to receive the role
contract GrantRole is ScriptBase {
    function run() external {
        address target = _requireEnvAddress("CONTRACT");
        address account = _requireEnvAddress("ACCOUNT");
        bytes32 role = _resolveRole(vm.envString("ROLE"));

        IAccessControl ac = IAccessControl(target);
        if (ac.hasRole(role, account)) {
            console.log("Account %s already has role %s", account, vm.toString(role));
            return;
        }

        vm.startBroadcast(_deployerKey());
        ac.grantRole(role, account);
        vm.stopBroadcast();

        console.log("Granted role %s to %s on %s", vm.toString(role), account, target);
    }

    function _resolveRole(string memory role) internal view returns (bytes32) {
        bytes memory raw = bytes(role);
        if (raw.length == 66 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X")) {
            return vm.parseBytes32(role);
        }
        return keccak256(raw);
    }
}
