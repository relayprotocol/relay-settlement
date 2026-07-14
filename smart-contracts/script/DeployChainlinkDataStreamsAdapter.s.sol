// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    ChainlinkDataStreamsAdapter,
    IVerifierProxy
} from "../contracts/price-adapters/ChainlinkDataStreamsAdapter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys ChainlinkDataStreamsAdapter, the `IPriceFeedAdapter` that
///         verifies Chainlink Data Streams V3 reports via a `VerifierProxy`.
///         Registering the adapter on `RelayPriceOracle` (`setPriceFeedAdapter`)
///         is a separate post-deploy step.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   VERIFIER_PROXY       – required, Chainlink `VerifierProxy` (or a stand-in,
///                          e.g. MockVerifierProxy) to verify reports against
///   FEE_TOKEN             – optional, fee token forwarded to `verify`
///                          (LINK or native fee token); defaults to the zero
///                          address for a zero-fee verifier config
contract DeployChainlinkDataStreamsAdapter is ScriptBase {
    function run() external returns (ChainlinkDataStreamsAdapter adapter) {
        address verifierProxy = _requireEnvAddress("VERIFIER_PROXY");
        address feeToken = vm.envOr("FEE_TOKEN", address(0));

        vm.startBroadcast(_deployerKey());
        adapter = new ChainlinkDataStreamsAdapter(
            IVerifierProxy(verifierProxy),
            feeToken
        );
        vm.stopBroadcast();

        _logDeployment("ChainlinkDataStreamsAdapter", address(adapter));
    }
}
