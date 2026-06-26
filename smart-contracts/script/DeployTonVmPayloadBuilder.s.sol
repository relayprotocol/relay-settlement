// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TonVmPayloadBuilder} from "../contracts/payload-builders/TonVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the TonVmPayloadBuilder contract for a Highload Wallet V3.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   SUBWALLET_ID         – required, Highload V3 subwallet id (uint32) baked into the wallet
///   TIMEOUT              – required, Highload V3 timeout in seconds (uint32) baked into the wallet
contract DeployTonVmPayloadBuilder is ScriptBase {
    function run() external returns (TonVmPayloadBuilder builder) {
        uint32 subwalletId = uint32(vm.envUint("SUBWALLET_ID"));
        uint32 timeout = uint32(vm.envUint("TIMEOUT"));

        vm.startBroadcast(_deployerKey());
        builder = new TonVmPayloadBuilder(subwalletId, timeout);
        vm.stopBroadcast();

        _logDeployment("TonVmPayloadBuilder", address(builder));
    }
}
