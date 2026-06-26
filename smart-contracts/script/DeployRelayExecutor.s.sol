// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayExecutor} from "../contracts/RelayExecutor.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayExecutor contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
///   HUB                  – required, RelayHub address
///   ALLOCATOR            – required, RelayAllocator address
contract DeployRelayExecutor is ScriptBase {
  function run() external returns (RelayExecutor verifier) {
    address admin = _envAddressOrDeployer("ADMIN");
    address hub = _requireEnvAddress("HUB");
    address allocator = _requireEnvAddress("ALLOCATOR");

    vm.startBroadcast(_deployerKey());
    verifier = new RelayExecutor(admin, hub, allocator);
    vm.stopBroadcast();

    _logDeployment("RelayExecutor", address(verifier));
  }
}
