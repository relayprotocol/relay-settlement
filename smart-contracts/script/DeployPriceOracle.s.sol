// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayPriceOracle} from "../contracts/RelayPriceOracle.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayPriceOracle contract that maps currencies to provider feed IDs.
///         Provider price feed adapters are registered after deployment.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   OWNER                – optional owner, defaults to deployer
contract DeployPriceOracle is ScriptBase {
  function run() external returns (RelayPriceOracle oracle) {
    address owner = _envAddressOrDeployer("OWNER");

    vm.startBroadcast(_deployerKey());
    oracle = new RelayPriceOracle(owner);
    vm.stopBroadcast();

    _logDeployment("RelayPriceOracle", address(oracle));
  }
}
