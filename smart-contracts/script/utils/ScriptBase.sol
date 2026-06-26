// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @notice Shared helpers for deployment scripts.
/// Centralises deployer-key resolution and consistent logging across the
/// script suite that replaces the Hardhat/Ignition deployment tasks.
abstract contract ScriptBase is Script {
    /// @notice Reads the deployer private key from `DEPLOYER_PRIVATE_KEY`, then
    /// falls back to forge's standard `PRIVATE_KEY`. Reverts when neither is set.
    function _deployerKey() internal view returns (uint256 pk) {
        pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            pk = vm.envOr("PRIVATE_KEY", uint256(0));
        }
        require(pk != 0, "ScriptBase: set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY");
    }

    /// @notice Returns the deployer address derived from the configured key.
    function _deployer() internal view returns (address) {
        return vm.addr(_deployerKey());
    }

    /// @notice Returns the address stored in `name`, defaulting to the deployer
    /// when the variable is unset or zero. Useful for `--owner` / `--admin`
    /// flags that Hardhat tasks treated as optional.
    function _envAddressOrDeployer(string memory name) internal view returns (address account) {
        account = vm.envOr(name, address(0));
        if (account == address(0)) {
            account = _deployer();
        }
    }

    /// @notice Reads an env-supplied address and reverts if it is unset.
    function _requireEnvAddress(string memory name) internal view returns (address account) {
        account = vm.envOr(name, address(0));
        require(account != address(0), string.concat("ScriptBase: env ", name, " is required"));
    }

    function _logDeployment(string memory label, address deployed) internal pure {
        console.log("%s deployed to: %s", label, deployed);
    }
}
