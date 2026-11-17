// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AtlasVmPayloadBuilder} from "../contracts/payload-builders/AtlasVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the AtlasVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
/// The EIP-712 signing domain and asset decimals of each Atlas instance are
/// Config values keyed by Relay chain id.
contract DeployAtlasVmPayloadBuilder is ScriptBase {
  function run() external returns (AtlasVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");

    vm.startBroadcast(_deployerKey());
    builder = new AtlasVmPayloadBuilder(config);
    vm.stopBroadcast();

    _logDeployment("AtlasVmPayloadBuilder", address(builder));
  }
}
