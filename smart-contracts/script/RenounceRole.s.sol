// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {console} from "forge-std/console.sol";

import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Renounces an AccessControl role for the deployer account.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – key whose role is being renounced (required)
///   CONTRACT             – required, target contract with AccessControl
///   ROLE                 – required, role name (e.g. "ORACLE_ROLE") or
///                          0x-prefixed bytes32 hash
contract RenounceRole is ScriptBase {
    function run() external {
        address target = _requireEnvAddress("CONTRACT");
        address account = _deployer();
        bytes32 role = _resolveRole(vm.envString("ROLE"));

        IAccessControl ac = IAccessControl(target);
        if (!ac.hasRole(role, account)) {
            console.log("Account %s does not hold role %s", account, vm.toString(role));
            return;
        }

        vm.startBroadcast(_deployerKey());
        ac.renounceRole(role, account);
        vm.stopBroadcast();

        console.log("Renounced role %s from %s on %s", vm.toString(role), account, target);
    }

    function _resolveRole(string memory role) internal view returns (bytes32) {
        bytes memory raw = bytes(role);
        if (raw.length == 66 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X")) {
            return vm.parseBytes32(role);
        }
        return keccak256(raw);
    }
}
