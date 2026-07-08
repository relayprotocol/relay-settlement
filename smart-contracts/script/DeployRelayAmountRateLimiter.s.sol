// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayAmountRateLimiter} from "../contracts/rate-limiters/RelayAmountRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayAmountRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
contract DeployRelayAmountRateLimiter is ScriptBase {
    function run() external returns (RelayAmountRateLimiter rateLimiter) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        rateLimiter = new RelayAmountRateLimiter(admin);
        vm.stopBroadcast();

        _logDeployment("RelayAmountRateLimiter", address(rateLimiter));
    }
}
