// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WithdrawGasPayer} from "../contracts/WithdrawGasPayer.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the WithdrawGasPayer contract. Gas fee currency and amount
/// are supplied to `payGas` and authorized by the oracle signature.
/// After deployment the contract must be granted OPERATOR_ROLE on the hub
/// (see GrantRole.s.sol).
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   HUB                  – required, RelayHub contract address
///   ORACLE               – required, oracle whose signature authorizes gas
///                          payments (the oracle multisig in production)
contract DeployWithdrawGasPayer is ScriptBase {
  function run() external returns (WithdrawGasPayer gasPayer) {
    address hub = _requireEnvAddress("HUB");
    address oracle = _requireEnvAddress("ORACLE");

    vm.startBroadcast(_deployerKey());
    gasPayer = new WithdrawGasPayer(hub, oracle);
    vm.stopBroadcast();

    _logDeployment("WithdrawGasPayer", address(gasPayer));
  }
}
