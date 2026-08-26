// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";

import {MulticallRouter} from "../contracts/routers/MulticallRouter.sol";
import {ScriptBase} from "./utils/ScriptBase.sol";

/// @notice Deploys the MulticallRouter contract on a withdrawal chain through a CREATE2 factory.
/// Run with `FOUNDRY_PROFILE=london` so every chain compiles the same initcode and gets the same
/// address; chains without the factory need it deployed first. Grant `DEPOSITORY_ROLE` to the
/// depository afterwards via `GrantRole.s.sol`.
/// Env:
///   DEPLOYER_PRIVATE_KEY – deployer key (required)
///   ADMIN                – optional, `ADMIN_ROLE` holder (defaults to deployer)
///   ROUTER_SALT          – optional, CREATE2 salt (defaults to `DEFAULT_SALT`)
///   CREATE2_FACTORY      – optional, must match forge's `--create2-deployer` (both default to
///                          `DEFAULT_CREATE2_FACTORY`)
contract DeployMulticallRouter is ScriptBase {
  /// @notice Thrown when the deployed address does not match the predicted one
  error IncorrectContractAddress(address predicted, address actual);

  /// @notice Canonical deterministic deployer, also forge's default `--create2-deployer`
  address public constant DEFAULT_CREATE2_FACTORY =
    0x4e59b44847b379578588920cA78FbF26c0B4956C;

  /// @notice Salt used when `ROUTER_SALT` is unset
  uint256 public constant DEFAULT_SALT = 1;

  function run() external returns (MulticallRouter router) {
    address admin = _envAddressOrDeployer("ADMIN");
    bytes32 salt = bytes32(vm.envOr("ROUTER_SALT", DEFAULT_SALT));
    address create2Factory = vm.envOr(
      "CREATE2_FACTORY",
      DEFAULT_CREATE2_FACTORY
    );

    bytes memory initCode = abi.encodePacked(
      type(MulticallRouter).creationCode,
      abi.encode(admin)
    );
    address predicted = vm.computeCreate2Address(
      salt,
      keccak256(initCode),
      create2Factory
    );

    console.log("MulticallRouter predicted address: %s", predicted);

    if (predicted.code.length != 0) {
      console.log("MulticallRouter already deployed");
      return MulticallRouter(payable(predicted));
    }

    vm.startBroadcast(_deployerKey());
    router = new MulticallRouter{salt: salt}(admin);
    vm.stopBroadcast();

    if (address(router) != predicted) {
      revert IncorrectContractAddress(predicted, address(router));
    }

    _logDeployment("MulticallRouter", address(router));
  }
}
