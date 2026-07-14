// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayUsdRateLimiter} from "../contracts/rate-limiters/RelayUsdRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayUsdRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
///   PRICE_ORACLE         – RelayPriceOracle address (required)
contract DeployRelayUsdRateLimiter is ScriptBase {
  function run() external returns (RelayUsdRateLimiter rateLimiter) {
    address admin = _envAddressOrDeployer("ADMIN");
    address priceOracle = _requireEnvAddress("PRICE_ORACLE");

    vm.startBroadcast(_deployerKey());
    rateLimiter = new RelayUsdRateLimiter(admin, priceOracle);
    vm.stopBroadcast();

    _logDeployment("RelayUsdRateLimiter", address(rateLimiter));
  }
}
