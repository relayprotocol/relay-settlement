// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LighterVmPayloadBuilder} from "../contracts/payload-builders/LighterVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the LighterVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
/// The depository account index and Lighter app-chain id of each Lighter
/// instance are Config values (see configure-lighter-vm-payload-builder.ts).
contract DeployLighterVmPayloadBuilder is ScriptBase {
  function run() external returns (LighterVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new LighterVmPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment("LighterVmPayloadBuilder", address(builder));
  }
}
