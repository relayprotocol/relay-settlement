// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolDrawResolver} from "../contracts/call-resolvers/PoolDrawResolver.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the pool draw-leg RelayExecutor call resolver.
/// Draw legs name their funding pool per leg, so the resolver binds no pool
/// at deployment; grant it RESOLVER_ROLE on each pool it should draw from.
/// Env:
///   DEPLOYER_PRIVATE_KEY - deployer key (required)
///   EXECUTOR             - RelayExecutor address (required)
///   HUB                  - RelayHub address (required)
contract DeployPoolDrawResolver is ScriptBase {
  function run() external returns (PoolDrawResolver resolver) {
    address executor = _requireEnvAddress("EXECUTOR");
    address hub = _requireEnvAddress("HUB");

    vm.startBroadcast(_deployerKey());
    resolver = new PoolDrawResolver(executor, hub);
    vm.stopBroadcast();

    _logDeployment("PoolDrawResolver", address(resolver));
  }
}
