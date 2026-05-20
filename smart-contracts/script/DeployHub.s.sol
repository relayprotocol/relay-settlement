// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayHub} from "../contracts/RelayHub.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayHub contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required, 0x-prefixed uint256)
///   ADMIN                – optional, defaults to the deployer
contract DeployHub is ScriptBase {
    function run() external returns (RelayHub hub) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        hub = new RelayHub(admin);
        vm.stopBroadcast();

        _logDeployment("RelayHub", address(hub));
    }
}
