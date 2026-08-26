// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HederaVmPayloadBuilder} from "../contracts/payload-builders/HederaVmPayloadBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the HederaVmPayloadBuilder contract.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   TOKEN_NUM            – required, entity number of the HTS token the builder
///                          may transfer (native Hedera USDC, 456858 on mainnet).
///                          The number differs per Hedera network, and the value
///                          is immutable once deployed.
///
/// Takes no gas payer: Hedera charges the fee to the transaction's payer, which
/// is the submitter rather than the depository, so withdrawals need no pre-paid
/// gas.
contract DeployHederaVmPayloadBuilder is ScriptBase {
  function run() external returns (HederaVmPayloadBuilder builder) {
    // Hedera declares entity numbers as protobuf int64, so a value past the
    // signed maximum could never name a real token and must not be truncated
    // into one that does.
    uint256 tokenNum = vm.envUint("TOKEN_NUM");
    require(
      tokenNum <= uint64(type(int64).max),
      "DeployHederaVmPayloadBuilder: TOKEN_NUM exceeds max entity num"
    );

    vm.startBroadcast(_deployerKey());
    builder = new HederaVmPayloadBuilder(uint64(tokenNum));
    vm.stopBroadcast();

    _logDeployment("HederaVmPayloadBuilder", address(builder));
  }
}
