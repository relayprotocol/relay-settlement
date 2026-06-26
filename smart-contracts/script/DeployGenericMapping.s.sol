// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayGenericMapping} from "../contracts/RelayGenericMapping.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayGenericMapping contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, admin address; defaults to the deployer
contract DeployGenericMapping is ScriptBase {
    function run() external returns (RelayGenericMapping mapping_) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        mapping_ = new RelayGenericMapping(admin);
        vm.stopBroadcast();

        _logDeployment("RelayGenericMapping", address(mapping_));
    }
}
