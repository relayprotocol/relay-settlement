// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TronVmPayloadBuilder} from "../contracts/payload-builders/TronVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the TronVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
contract DeployTronVmPayloadBuilder is ScriptBase {
  function run() external returns (TronVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new TronVmPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment("TronVmPayloadBuilder", address(builder));
  }
}
