// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleV2} from "../contracts/RelayOracleV2.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayOracleV2 contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
///   HUB                  – required, RelayHub address the oracle reports to
///   IDEMPOTENCY_STORE    – required, shared idempotency store address
/// Role wiring (ORACLE_ROLE grant, RelayHub OPERATOR_ROLE, idempotency store
/// WRITE_ROLE, RelayAmountRateLimiter CONSUMER_ROLE, addRateLimiter,
/// addFeeCalculator) is a separate post-deploy step.
contract DeployRelayOracleV2 is ScriptBase {
  function run() external returns (RelayOracleV2 oracle) {
    address admin = _envAddressOrDeployer("ADMIN");
    address hub = _requireEnvAddress("HUB");
    address idempotencyStore = _requireEnvAddress("IDEMPOTENCY_STORE");

    vm.startBroadcast(_deployerKey());
    oracle = new RelayOracleV2(admin, hub, idempotencyStore);
    vm.stopBroadcast();

    _logDeployment("RelayOracleV2", address(oracle));
  }
}
