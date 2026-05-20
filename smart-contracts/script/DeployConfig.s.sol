// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "../contracts/Config.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the Config contract that backs the allocator.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ALLOCATOR            – required, RelayAllocator address whose owner administers the config
contract DeployConfig is ScriptBase {
    function run() external returns (Config config) {
        address allocator = _requireEnvAddress("ALLOCATOR");

        vm.startBroadcast(_deployerKey());
        config = new Config(allocator);
        vm.stopBroadcast();

        _logDeployment("Config", address(config));
    }
}
