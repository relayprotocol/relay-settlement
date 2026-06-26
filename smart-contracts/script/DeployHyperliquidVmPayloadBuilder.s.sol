// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HyperliquidVmPayloadBuilder} from "../contracts/payload-builders/HyperliquidVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the HyperliquidVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   CONFIG               – required, Config contract address
///   SIGNATURE_CHAIN_ID   – required, Hyperliquid EIP-712 domain chain id
///   HYPERLIQUID_CHAIN    – required, Hyperliquid environment name (e.g. Mainnet)
contract DeployHyperliquidVmPayloadBuilder is ScriptBase {
  function run() external returns (HyperliquidVmPayloadBuilder builder) {
    address config = _requireEnvAddress("CONFIG");
    uint256 signatureChainId = vm.envUint("SIGNATURE_CHAIN_ID");
    string memory hyperliquidChain = vm.envString("HYPERLIQUID_CHAIN");

    vm.startBroadcast(_deployerKey());
    builder = new HyperliquidVmPayloadBuilder(
      config,
      signatureChainId,
      hyperliquidChain
    );
    vm.stopBroadcast();

    _logDeployment("HyperliquidVmPayloadBuilder", address(builder));
  }
}
