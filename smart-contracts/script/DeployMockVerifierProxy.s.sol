// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys MockVerifierProxy — a stand-in for Chainlink's `VerifierProxy`
///         that unwraps a `fullReport` envelope without checking DON signatures
///         or charging a fee. Only for environments without a real Chainlink
///         Data Streams verifier deployment (see docs/data-streams-onchain-verifier.md).
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
contract DeployMockVerifierProxy is ScriptBase {
    function run() external returns (MockVerifierProxy verifierProxy) {
        vm.startBroadcast(_deployerKey());
        verifierProxy = new MockVerifierProxy();
        vm.stopBroadcast();

        _logDeployment("MockVerifierProxy", address(verifierProxy));
    }
}
