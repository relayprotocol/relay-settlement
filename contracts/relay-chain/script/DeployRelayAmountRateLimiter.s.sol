// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayAmountRateLimiter} from "../contracts/rate-limiters/RelayAmountRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayAmountRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – governance Safe granted ADMIN_ROLE (required; no deployer default)
contract DeployRelayAmountRateLimiter is ScriptBase {
  function run() external returns (RelayAmountRateLimiter rateLimiter) {
    rateLimiter = deploy(vm.envOr("ADMIN", address(0)), _deployerKey());
  }

  /// @notice Env-free entrypoint so tests can drive the deploy without vm.setEnv.
  function deploy(
    address admin,
    uint256 deployerKey
  ) public returns (RelayAmountRateLimiter rateLimiter) {
    require(
      admin != address(0),
      "DeployRelayAmountRateLimiter: ADMIN is required"
    );

    vm.startBroadcast(deployerKey);
    rateLimiter = new RelayAmountRateLimiter(admin);
    vm.stopBroadcast();

    _logDeployment("RelayAmountRateLimiter", address(rateLimiter));
  }
}
