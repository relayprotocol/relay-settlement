// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatewayVmPayloadBuilder} from "../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the GatewayVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeployGatewayVmPayloadBuilder is ScriptBase {
  function run() external returns (GatewayVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new GatewayVmPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment("GatewayVmPayloadBuilder", address(builder));
  }
}
