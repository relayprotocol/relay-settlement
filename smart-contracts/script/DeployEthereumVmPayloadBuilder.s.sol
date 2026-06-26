// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EthereumVmPayloadBuilder} from "../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the EthereumVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeployEthereumVmPayloadBuilder is ScriptBase {
    function run() external returns (EthereumVmPayloadBuilder builder) {
        address config = _requireEnvAddress("CONFIG");

        vm.startBroadcast(_deployerKey());
        builder = new EthereumVmPayloadBuilder(config);
        vm.stopBroadcast();

        _logDeployment("EthereumVmPayloadBuilder", address(builder));
    }
}
