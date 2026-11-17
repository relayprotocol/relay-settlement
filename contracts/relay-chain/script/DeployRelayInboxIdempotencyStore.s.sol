// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayInboxIdempotencyStore} from "../contracts/RelayInboxIdempotencyStore.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayInboxIdempotencyStore contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
/// Sources should be added after deployment with RelayInboxIdempotencyStore.addSource.
contract DeployRelayInboxIdempotencyStore is ScriptBase {
    function run() external returns (RelayInboxIdempotencyStore store) {
        address admin = _envAddressOrDeployer("ADMIN");

        vm.startBroadcast(_deployerKey());
        store = new RelayInboxIdempotencyStore(admin);
        vm.stopBroadcast();

        _logDeployment("RelayInboxIdempotencyStore", address(store));
    }
}
