// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Multicall3} from "../contracts/Multicall3.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @title DeployMulticall3
/// @author Relay Protocol
/// @notice Deploys Multicall3.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required; PRIVATE_KEY also supported)
contract DeployMulticall3 is ScriptBase {
  /// @notice Deploys Multicall3.
  /// @return multicall The deployed contract
  function run() external returns (Multicall3 multicall) {
    vm.startBroadcast(_deployerKey());
    multicall = new Multicall3();
    vm.stopBroadcast();

    _logDeployment("Multicall3", address(multicall));
  }
}
