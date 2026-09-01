// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignedPricingOracle} from "../contracts/deposit-addresses/oracle/SignedPricingOracle.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @title DeploySignedPricingOracle
/// @author Relay Protocol
/// @notice Deploys a SignedPricingOracle bound to one solver and RelayPriceOracle.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required; PRIVATE_KEY also supported)
///   SOLVER               – required, only signer accepted by the oracle
///   RELAY_PRICE_ORACLE    – required, on-chain oracle queried before signed prices
contract DeploySignedPricingOracle is ScriptBase {
  /// @notice Deploys the environment-configured SignedPricingOracle.
  /// @return oracle The deployed oracle
  function run() external returns (SignedPricingOracle oracle) {
    address solver = _requireEnvAddress("SOLVER");
    address relayPriceOracle = _requireEnvAddress("RELAY_PRICE_ORACLE");

    vm.startBroadcast(_deployerKey());
    oracle = new SignedPricingOracle(solver, relayPriceOracle);
    vm.stopBroadcast();

    _logDeployment("SignedPricingOracle", address(oracle));
  }
}
