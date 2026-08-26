// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IStorkFastVerifier,
    StorkFastAdapter
} from "../contracts/price-adapters/StorkFastAdapter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys StorkFastAdapter, the `IPriceFeedAdapter` that verifies
///         Stork Fast signed ECDSA payloads through an on-chain verifier.
///         Registering the adapter on `RelayPriceOracle` (`setPriceFeedAdapter`)
///         is a separate post-deploy step.
/// Env:
///   DEPLOYER_PRIVATE_KEY - deployer key (required)
///   RELAY_PRICE_ORACLE   - required, authorized RelayPriceOracle
///   STORK_FAST_VERIFIER  - required, Stork Fast verifier contract
contract DeployStorkFastAdapter is ScriptBase {
    function run() external returns (StorkFastAdapter adapter) {
        address relayPriceOracle = _requireEnvAddress("RELAY_PRICE_ORACLE");
        address storkFastVerifier = _requireEnvAddress("STORK_FAST_VERIFIER");

        vm.startBroadcast(_deployerKey());
        adapter = new StorkFastAdapter(
            relayPriceOracle,
            IStorkFastVerifier(storkFastVerifier)
        );
        vm.stopBroadcast();

        _logDeployment("StorkFastAdapter", address(adapter));
    }
}
