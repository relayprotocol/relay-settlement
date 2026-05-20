// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";

import {DepositAddressFactory} from "../contracts/deposit-addresses/strict/ethereum/DepositAddressFactory.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the DepositAddressFactory via Arachnid's deterministic
/// deployment proxy at 0x4e59b44847b379578588920cA78FbF26c0B4956C so the
/// factory ends up at the same address on every chain.
/// See https://github.com/Arachnid/deterministic-deployment-proxy.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   DEPOSITORY           – required, depository contract address on this chain
///   SALT                 – optional, salt override (defaults to keccak256("relay_deposit_address_factory"))
contract DeployDepositAddressFactory is ScriptBase {
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant DEFAULT_SALT = keccak256("relay_deposit_address_factory");

    function run() external returns (address factory) {
        address depository = _requireEnvAddress("DEPOSITORY");
        bytes32 salt = vm.envOr("SALT", DEFAULT_SALT);

        require(DETERMINISTIC_DEPLOYER.code.length > 0, "DeployDepositAddressFactory: deterministic deployer missing on this chain");
        require(depository.code.length > 0, "DeployDepositAddressFactory: depository has no code on this chain");

        bytes memory initCode = abi.encodePacked(type(DepositAddressFactory).creationCode, abi.encode(depository));
        factory = vm.computeCreate2Address(salt, keccak256(initCode), DETERMINISTIC_DEPLOYER);

        if (factory.code.length > 0) {
            console.log("DepositAddressFactory already deployed at: %s", factory);
            return factory;
        }

        vm.startBroadcast(_deployerKey());
        (bool ok, ) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok, "DeployDepositAddressFactory: deterministic deploy reverted");
        vm.stopBroadcast();

        require(factory.code.length > 0, "DeployDepositAddressFactory: factory missing after deploy");
        _logDeployment("DepositAddressFactory", factory);
    }
}
