// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayInboxMultisig} from "../contracts/RelayInboxMultisig.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayInboxMultisig contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   OWNER                – optional, defaults to the deployer
///   SIGNERS              – required, comma-separated signer addresses
///   THRESHOLD            – required, minimum number of signatures
contract DeployOracleMultisig is ScriptBase {
    function run() external returns (RelayInboxMultisig multisig) {
        address owner = _envAddressOrDeployer("OWNER");
        address[] memory signers = vm.envAddress("SIGNERS", ",");
        uint256 threshold = vm.envUint("THRESHOLD");

        vm.startBroadcast(_deployerKey());
        multisig = new RelayInboxMultisig(owner, signers, threshold);
        vm.stopBroadcast();

        _logDeployment("RelayInboxMultisig", address(multisig));
    }
}
