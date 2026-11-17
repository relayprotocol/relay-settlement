// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BitcoinVmPayloadBuilder} from "../contracts/payload-builders/BitcoinVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the BitcoinVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY     – deployer key (required)
///   CONFIG                   – Config contract address (required)
///   ALLOCATOR_CHANGE_SCRIPT  – allocator change scriptPubKey as hex bytes (required)
contract DeployBitcoinVmPayloadBuilder is ScriptBase {
  function run() external returns (BitcoinVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");
    bytes memory allocatorChangeScript = vm.parseBytes(
      vm.envString("ALLOCATOR_CHANGE_SCRIPT")
    );

    vm.startBroadcast(_deployerKey());
    builder = new BitcoinVmPayloadBuilder(config, allocatorChangeScript);
    vm.stopBroadcast();

    _logDeployment("BitcoinVmPayloadBuilder", address(builder));
  }
}
