// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayFastRateLimiter} from "../contracts/RelayFastRateLimiter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayFastRateLimiter contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
contract DeployRelayFastRateLimiter is ScriptBase {
    function run() external returns (RelayFastRateLimiter rateLimiter) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        rateLimiter = new RelayFastRateLimiter(admin);
        vm.stopBroadcast();

        _logDeployment("RelayFastRateLimiter", address(rateLimiter));
    }
}
