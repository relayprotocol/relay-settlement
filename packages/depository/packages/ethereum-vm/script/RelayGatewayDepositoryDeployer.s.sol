// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";

import {RelayGatewayDepository} from "../src/RelayGatewayDepository.sol";

/// @notice Deterministically deploys RelayGatewayDepository through the configured CREATE2 factory
contract RelayGatewayDepositoryDeployer is Script {
  error IncorrectContractAddress(address predicted, address actual);

  uint256 public constant DEFAULT_SALT = 1;

  function run() public {
    address owner = vm.envAddress("GATEWAY_DEPOSITORY_OWNER");
    address allocator = vm.envAddress("GATEWAY_ALLOCATOR");
    bytes32 salt = bytes32(
      vm.envOr("GATEWAY_DEPOSITORY_SALT", DEFAULT_SALT)
    );

    vm.startBroadcast();

    RelayGatewayDepository depository = RelayGatewayDepository(
      deployRelayGatewayDepository(owner, allocator, salt)
    );

    assert(depository.owner() == owner);
    assert(depository.allocator() == allocator);
    assert(
      depository.GATEWAY_WALLET() ==
        0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE
    );
    assert(
      depository.GATEWAY_MINTER() ==
        0x2222222d7164433c4C09B0b0D809a9b52C04C205
    );

    vm.stopBroadcast();
  }

  function deployRelayGatewayDepository(
    address owner,
    address allocator,
    bytes32 salt
  ) public returns (address) {
    bytes memory initCode = abi.encodePacked(
      type(RelayGatewayDepository).creationCode,
      abi.encode(owner, allocator)
    );
    address create2Factory = vm.envAddress("CREATE2_FACTORY");
    address predictedAddress = vm.computeCreate2Address(
      salt,
      keccak256(initCode),
      create2Factory
    );

    console2.log("RelayGatewayDepository predicted address", predictedAddress);

    if (predictedAddress.code.length != 0) {
      console2.log("RelayGatewayDepository was already deployed");
      return predictedAddress;
    }

    RelayGatewayDepository depository = new RelayGatewayDepository{salt: salt}(
      owner,
      allocator
    );
    if (predictedAddress != address(depository)) {
      revert IncorrectContractAddress(
        predictedAddress,
        address(depository)
      );
    }

    console2.log("RelayGatewayDepository deployed");
    return address(depository);
  }
}
