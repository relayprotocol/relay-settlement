// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BitcoinDepositAddress} from "../contracts/deposit-addresses/strict/bitcoin/BitcoinDepositAddress.sol";
import {BitcoinDepositSweepBuilder} from "../contracts/deposit-addresses/strict/bitcoin/BitcoinDepositSweepBuilder.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the BitcoinDepositSweepBuilder and BitcoinDepositAddress contracts.
/// Both contracts link external libraries (`AuroraSdk`, `ChainSignatures`).
/// Pass their addresses via the forge `--libraries` flag.
///
/// The depository script is a Base64-encoded Bitcoin output script. Use any
/// tool that exposes `bitcoinjs-lib.address.toOutputScript(...).toString('base64')`
/// to compute it (the legacy `tasks/deployments/bitcoinDepositAddress.ts` does
/// the same conversion).
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   OWNER                – optional, defaults to the deployer
///   DEPOSITORY_SCRIPT    – required, Base64-encoded depository output script
///   NEAR_SIGNER          – required, NEAR signer account id
///   WNEAR                – required, wNEAR ERC20 token address
///   MAX_FEE_RATE         – optional, max Bitcoin fee rate in sats/vbyte (default 100)
contract DeployBitcoinDepositAddress is ScriptBase {
    function run() external returns (BitcoinDepositAddress depositAddress, BitcoinDepositSweepBuilder sweepBuilder) {
        address owner = _envAddressOrDeployer("OWNER");
        string memory depositoryScript = vm.envString("DEPOSITORY_SCRIPT");
        string memory nearSigner = vm.envString("NEAR_SIGNER");
        address wNEAR = _requireEnvAddress("WNEAR");
        uint64 maxFeeRate = uint64(vm.envOr("MAX_FEE_RATE", uint256(100)));

        vm.startBroadcast(_deployerKey());
        sweepBuilder = new BitcoinDepositSweepBuilder(owner, depositoryScript, maxFeeRate);
        depositAddress = new BitcoinDepositAddress(owner, address(sweepBuilder), nearSigner, wNEAR);
        vm.stopBroadcast();

        _logDeployment("BitcoinDepositSweepBuilder", address(sweepBuilder));
        _logDeployment("BitcoinDepositAddress", address(depositAddress));
    }
}
