// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayUsdRateLimiter} from "../contracts/rate-limiters/RelayUsdRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayUsdRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – governance Safe granted ADMIN_ROLE (required; no deployer default)
///   PRICE_ORACLE         – RelayPriceOracle address (required)
contract DeployRelayUsdRateLimiter is ScriptBase {
  function run() external returns (RelayUsdRateLimiter rateLimiter) {
    rateLimiter = deploy(
      vm.envOr("ADMIN", address(0)),
      _requireEnvAddress("PRICE_ORACLE"),
      _deployerKey()
    );
  }

  /// @notice Env-free entrypoint so tests can drive the deploy without vm.setEnv.
  function deploy(
    address admin,
    address priceOracle,
    uint256 deployerKey
  ) public returns (RelayUsdRateLimiter rateLimiter) {
    require(
      admin != address(0),
      "DeployRelayUsdRateLimiter: ADMIN is required"
    );

    vm.startBroadcast(deployerKey);
    rateLimiter = new RelayUsdRateLimiter(admin, priceOracle);
    vm.stopBroadcast();

    _logDeployment("RelayUsdRateLimiter", address(rateLimiter));
  }
}
