// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TonVmPayloadBuilder} from "../contracts/payload-builders/TonVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the TonVmPayloadBuilder contract for a Highload Wallet V3.
/// A wallet already in use needs the cutover wait described in the README.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
///   ALLOCATOR            – required, RelayAllocator allowed to build (its withdrawal count numbers query ids)
///   CHAIN_ID             – required, Relay chain id of the Highload V3 wallet (e.g. "ton")
///   SUBWALLET_ID         – required, Highload V3 subwallet id (uint32) baked into the wallet
///   TIMEOUT              – required, Highload V3 timeout in seconds (uint32) baked into the wallet
contract DeployTonVmPayloadBuilder is ScriptBase {
  function run() external returns (TonVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");
    address allocator = _requireEnvAddress("ALLOCATOR");
    string memory chainId = vm.envString("CHAIN_ID");
    uint32 subwalletId = uint32(vm.envUint("SUBWALLET_ID"));
    uint32 timeout = uint32(vm.envUint("TIMEOUT"));

    vm.startBroadcast(_deployerKey());
    builder = new TonVmPayloadBuilder(
      config,
      allocator,
      chainId,
      subwalletId,
      timeout
    );
    vm.stopBroadcast();

    _logDeployment("TonVmPayloadBuilder", address(builder));
  }
}
