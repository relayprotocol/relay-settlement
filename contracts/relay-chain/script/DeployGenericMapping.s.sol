// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayGenericMapping} from "../contracts/RelayGenericMapping.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayGenericMapping contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, admin address; defaults to the deployer
///   LEGACY               – optional, previous RelayGenericMapping whose entries read
///                          through; defaults to none
contract DeployGenericMapping is ScriptBase {
    function run() external returns (RelayGenericMapping mapping_) {
        address admin = _envAddressOrDeployer("ADMIN");
        address legacy = vm.envOr("LEGACY", address(0));

        vm.startBroadcast(_deployerKey());
        mapping_ = new RelayGenericMapping(admin, legacy);
        vm.stopBroadcast();

        _logDeployment("RelayGenericMapping", address(mapping_));
    }
}
