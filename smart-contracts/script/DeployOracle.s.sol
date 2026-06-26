// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracle} from "../contracts/RelayOracle.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayOracle contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, defaults to the deployer
///   HUB                  – required, RelayHub address the oracle reports to
contract DeployOracle is ScriptBase {
    function run() external returns (RelayOracle oracle) {
        address admin = _envAddressOrDeployer("ADMIN");
        address hub = _requireEnvAddress("HUB");

        vm.startBroadcast(_deployerKey());
        oracle = new RelayOracle(admin, hub);
        vm.stopBroadcast();

        _logDeployment("RelayOracle", address(oracle));
    }
}
