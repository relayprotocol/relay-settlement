// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayDepositAddressManager} from "../contracts/deposit-addresses/RelayDepositAddressManager.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayDepositAddressManager contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
contract DeployDepositAddressManager is ScriptBase {
    function run() external returns (RelayDepositAddressManager manager) {
        vm.startBroadcast(_deployerKey());
        manager = new RelayDepositAddressManager();
        vm.stopBroadcast();

        _logDeployment("RelayDepositAddressManager", address(manager));
    }
}
