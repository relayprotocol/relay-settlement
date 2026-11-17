// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayMultisigSigner} from "../contracts/RelayMultisigSigner.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayMultisigSigner contract.
/// The signer pulls in `AuroraSdk` (which itself links `AuroraXccUtils` and
/// `Codec`) and `ChainSignatures`. Forge will deploy these libraries as part
/// of the script run; on Aurora mainnet they already exist (see
/// `libraries.json`), so pass them via the forge `--libraries` flag to reuse
/// pinned addresses.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   MULTISIG             – required, address of the multisig that owns the signer
///   NEAR_SIGNER          – required, NEAR account id of the Chain Signatures signer
///                          (e.g. `v1.signer` or `v1.signer-prod.testnet`)
///   WNEAR                – required, wNEAR ERC20 token address on the target chain
contract DeployRelayMultisigSigner is ScriptBase {
    function run() external returns (RelayMultisigSigner signer) {
        address multisig = _requireEnvAddress("MULTISIG");
        string memory nearSigner = vm.envString("NEAR_SIGNER");
        address wNEAR = _requireEnvAddress("WNEAR");

        vm.startBroadcast(_deployerKey());
        signer = new RelayMultisigSigner(multisig, nearSigner, wNEAR);
        vm.stopBroadcast();

        _logDeployment("RelayMultisigSigner", address(signer));
    }
}
