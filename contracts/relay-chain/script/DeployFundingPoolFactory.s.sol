// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FundingPoolFactory} from "../contracts/funding-pools/FundingPoolFactory.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the deterministic FundingPool factory.
/// Env:
///   DEPLOYER_PRIVATE_KEY - deployer key (required)
contract DeployFundingPoolFactory is ScriptBase {
  function run() external returns (FundingPoolFactory factory) {
    vm.startBroadcast(_deployerKey());
    factory = new FundingPoolFactory();
    vm.stopBroadcast();

    _logDeployment("FundingPoolFactory", address(factory));
  }
}
