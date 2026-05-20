// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasicPricingOracle} from "../contracts/deposit-addresses/open/oracle/BasicPricingOracle.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the BasicPricingOracle contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
contract DeployBasicPricingOracle is ScriptBase {
    function run() external returns (BasicPricingOracle oracle) {
        vm.startBroadcast(_deployerKey());
        oracle = new BasicPricingOracle();
        vm.stopBroadcast();

        _logDeployment("BasicPricingOracle", address(oracle));
    }
}
