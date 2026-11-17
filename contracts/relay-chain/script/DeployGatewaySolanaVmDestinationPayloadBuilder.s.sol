// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatewaySolanaVmDestinationPayloadBuilder} from "../contracts/payload-builders/gateway/GatewaySolanaVmDestinationPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the GatewaySolanaVmDestinationPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeployGatewaySolanaVmDestinationPayloadBuilder is ScriptBase {
  function run()
    external
    returns (GatewaySolanaVmDestinationPayloadBuilder builder)
  {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new GatewaySolanaVmDestinationPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment(
      "GatewaySolanaVmDestinationPayloadBuilder",
      address(builder)
    );
  }
}
