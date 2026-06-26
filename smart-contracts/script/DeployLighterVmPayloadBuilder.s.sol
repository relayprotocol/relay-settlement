// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LighterVmPayloadBuilder} from "../contracts/payload-builders/LighterVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the LighterVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
///   FROM_ACCOUNT_INDEX   – required, depository account index on Lighter
///   LIGHTER_CHAIN_ID     – required, Lighter chain id used in signed transfers
contract DeployLighterVmPayloadBuilder is ScriptBase {
  function run() external returns (LighterVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");
    uint64 fromAccountIndex = uint64(vm.envUint("FROM_ACCOUNT_INDEX"));
    uint64 lighterChainId = uint64(vm.envUint("LIGHTER_CHAIN_ID"));

    vm.startBroadcast(_deployerKey());
    builder = new LighterVmPayloadBuilder(
      config,
      fromAccountIndex,
      lighterChainId
    );
    vm.stopBroadcast();

    _logDeployment("LighterVmPayloadBuilder", address(builder));
  }
}
