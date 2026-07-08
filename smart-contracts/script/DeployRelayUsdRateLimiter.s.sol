// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayUsdRateLimiter} from "../contracts/rate-limiters/RelayUsdRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayUsdRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
contract DeployRelayUsdRateLimiter is ScriptBase {
    function run() external returns (RelayUsdRateLimiter rateLimiter) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        rateLimiter = new RelayUsdRateLimiter(admin);
        vm.stopBroadcast();

        _logDeployment("RelayUsdRateLimiter", address(rateLimiter));
    }
}
