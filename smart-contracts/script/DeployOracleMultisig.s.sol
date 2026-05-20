// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleMultisig} from "../contracts/RelayOracleMultisig.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayOracleMultisig contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   OWNER                – optional, defaults to the deployer
///   SIGNERS              – required, comma-separated signer addresses
///   THRESHOLD            – required, minimum number of signatures
contract DeployOracleMultisig is ScriptBase {
    function run() external returns (RelayOracleMultisig multisig) {
        address owner = _envAddressOrDeployer("OWNER");
        address[] memory signers = vm.envAddress("SIGNERS", ",");
        uint256 threshold = vm.envUint("THRESHOLD");

        vm.startBroadcast(_deployerKey());
        multisig = new RelayOracleMultisig(owner, signers, threshold);
        vm.stopBroadcast();

        _logDeployment("RelayOracleMultisig", address(multisig));
    }
}
