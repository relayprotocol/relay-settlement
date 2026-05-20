// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20View} from "../contracts/ERC20View.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the ERC20View contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   TOKEN_ID             – optional token id seed (defaults to 0)
contract DeployErc20View is ScriptBase {
    function run() external returns (ERC20View view_) {
        uint256 tokenId = vm.envOr("TOKEN_ID", uint256(0));

        vm.startBroadcast(_deployerKey());
        view_ = new ERC20View(tokenId);
        vm.stopBroadcast();

        _logDeployment("ERC20View", address(view_));
    }
}
