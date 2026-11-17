// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SolanaVmPayloadBuilder} from "../contracts/payload-builders/SolanaVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the SolanaVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeploySolanaVmPayloadBuilder is ScriptBase {
    function run() external returns (SolanaVmPayloadBuilder builder) {
        address config = _requireEnvAddress("CONFIG");

        vm.startBroadcast(_deployerKey());
        builder = new SolanaVmPayloadBuilder(config);
        vm.stopBroadcast();

        _logDeployment("SolanaVmPayloadBuilder", address(builder));
    }
}
