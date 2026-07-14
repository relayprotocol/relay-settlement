// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleIdempotencyStore} from "../contracts/RelayOracleIdempotencyStore.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayOracleIdempotencyStore contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
/// Sources should be added after deployment with RelayOracleIdempotencyStore.addSource.
contract DeployRelayOracleIdempotencyStore is ScriptBase {
    function run() external returns (RelayOracleIdempotencyStore store) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        store = new RelayOracleIdempotencyStore(admin);
        vm.stopBroadcast();

        _logDeployment("RelayOracleIdempotencyStore", address(store));
    }
}
