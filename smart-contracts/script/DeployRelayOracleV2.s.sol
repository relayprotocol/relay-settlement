// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleV2} from "../contracts/RelayOracleV2.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayOracleV2 contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
///   HUB                  – required, RelayHub address the oracle reports to
///   OLD_ORACLE           – optional, the predecessor RelayOracle whose idempotency
///                          keys must be honoured (zero when there is none; a
///                          non-zero value must be a live RelayOracle)
/// Role wiring (ORACLE_ROLE grant, RelayHub OPERATOR_ROLE, RelayFastRateLimiter
/// CONSUMER_ROLE + setRateLimiter) is a separate post-deploy step.
contract DeployRelayOracleV2 is ScriptBase {
    function run() external returns (RelayOracleV2 oracle) {
        address admin = _envAddressOrDeployer("ADMIN");
        address hub = _requireEnvAddress("HUB");
        address oldOracle = vm.envOr("OLD_ORACLE", address(0));

        vm.startBroadcast(_deployerKey());
        oracle = new RelayOracleV2(admin, hub, oldOracle);
        vm.stopBroadcast();

        _logDeployment("RelayOracleV2", address(oracle));
    }
}
