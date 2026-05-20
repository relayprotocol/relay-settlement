// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayAllocator} from "../contracts/RelayAllocator.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the RelayAllocator contract.
/// The allocator links the `Utils` external library; pass its address via the
/// `--libraries` flag, or run `script/DeployUtils.s.sol` first and supply the
/// result. Forge's broadcast will print the deployed address.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   OWNER                – optional, defaults to the deployer
///   HUB                  – required, RelayHub address
///   ORACLE               – required, RelayOracle address used to verify spender signatures
contract DeployAllocator is ScriptBase {
    function run() external returns (RelayAllocator allocator) {
        address owner = _envAddressOrDeployer("OWNER");
        address hub = _requireEnvAddress("HUB");
        address oracle = _requireEnvAddress("ORACLE");

        vm.startBroadcast(_deployerKey());
        allocator = new RelayAllocator(owner, hub, oracle);
        vm.stopBroadcast();

        _logDeployment("RelayAllocator", address(allocator));
    }
}
