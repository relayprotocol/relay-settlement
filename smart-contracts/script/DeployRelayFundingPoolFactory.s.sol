// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayFundingPoolFactory} from "../contracts/funding-pools/RelayFundingPoolFactory.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the deterministic RelayFundingPool factory.
/// Env:
///   DEPLOYER_PRIVATE_KEY - deployer key (required)
contract DeployRelayFundingPoolFactory is ScriptBase {
  function run() external returns (RelayFundingPoolFactory factory) {
    vm.startBroadcast(_deployerKey());
    factory = new RelayFundingPoolFactory();
    vm.stopBroadcast();

    _logDeployment("RelayFundingPoolFactory", address(factory));
  }
}
