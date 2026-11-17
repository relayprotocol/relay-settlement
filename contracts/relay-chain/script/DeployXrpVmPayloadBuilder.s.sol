// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {XrpVmPayloadBuilder} from "../contracts/payload-builders/XrpVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the XrpVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   SIGNING_PUBKEY       – required, 33-byte compressed secp256k1 public key
///                          (0x-prefixed hex) of the allocator's XRP signer
contract DeployXrpVmPayloadBuilder is ScriptBase {
  function run() external returns (XrpVmPayloadBuilder builder) {
    bytes memory signingPubKey = vm.envBytes("SIGNING_PUBKEY");

    vm.startBroadcast(_deployerKey());
    builder = new XrpVmPayloadBuilder(signingPubKey);
    vm.stopBroadcast();

    _logDeployment("XrpVmPayloadBuilder", address(builder));
  }
}
