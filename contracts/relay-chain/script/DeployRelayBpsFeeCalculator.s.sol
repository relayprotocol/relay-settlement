// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayBpsFeeCalculator} from "../contracts/fee-calculators/RelayBpsFeeCalculator.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayBpsFeeCalculator contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   PRICE_ORACLE         – RelayPriceOracle address (required)
contract DeployRelayBpsFeeCalculator is ScriptBase {
  function run() external returns (RelayBpsFeeCalculator feeCalculator) {
    address priceOracle = _requireEnvAddress("PRICE_ORACLE");

    vm.startBroadcast(_deployerKey());
    feeCalculator = new RelayBpsFeeCalculator(priceOracle);
    vm.stopBroadcast();

    _logDeployment("RelayBpsFeeCalculator", address(feeCalculator));
  }
}
