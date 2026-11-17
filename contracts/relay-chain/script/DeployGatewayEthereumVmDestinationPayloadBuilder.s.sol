// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatewayEthereumVmDestinationPayloadBuilder} from "../contracts/payload-builders/gateway/GatewayEthereumVmDestinationPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the GatewayEthereumVmDestinationPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeployGatewayEthereumVmDestinationPayloadBuilder is ScriptBase {
  function run()
    external
    returns (GatewayEthereumVmDestinationPayloadBuilder builder)
  {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new GatewayEthereumVmDestinationPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment(
      "GatewayEthereumVmDestinationPayloadBuilder",
      address(builder)
    );
  }
}
