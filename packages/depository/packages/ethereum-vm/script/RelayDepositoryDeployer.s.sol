// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";

import {RelayDepository} from "../src/RelayDepository.sol";

contract RelayDepositoryDeployer is Script {
  // Thrown when the predicted address doesn't match the deployed address
  error IncorrectContractAddress(address predicted, address actual);

  // Default salt when DEPOSITORY_SALT is not provided
  uint256 public constant DEFAULT_SALT = 1;

  function setUp() public {}

  function run() public {
    // Optional fork selection — when running via `forge script --rpc-url ...`
    // the broadcast target is already set, so CHAIN can be left unset.
    string memory chain = vm.envOr("CHAIN", string(""));
    if (bytes(chain).length > 0) {
      vm.createSelectFork(chain);
    }

    vm.startBroadcast();

    address allocator = vm.envAddress("ALLOCATOR");
    address owner = vm.envOr("DEPOSITORY_OWNER", msg.sender);
    bytes32 salt = bytes32(vm.envOr("DEPOSITORY_SALT", DEFAULT_SALT));

    RelayDepository relayDepository = RelayDepository(
      payable(deployRelayDepository(owner, allocator, salt))
    );

    assert(relayDepository.allocator() == allocator);
    assert(relayDepository.owner() == owner);

    vm.stopBroadcast();
  }

  function deployRelayDepository(
    address owner,
    address allocator,
    bytes32 salt
  ) public returns (address) {
    console2.log("Deploying RelayDepository");
    console2.log("  owner:    ", owner);
    console2.log("  allocator:", allocator);
    console2.logBytes32(salt);

    address create2Factory = vm.envAddress("CREATE2_FACTORY");

    // Compute predicted address
    address predictedAddress = address(
      uint160(
        uint(
          keccak256(
            abi.encodePacked(
              bytes1(0xff),
              create2Factory,
              salt,
              keccak256(
                abi.encodePacked(
                  type(RelayDepository).creationCode,
                  abi.encode(owner, allocator)
                )
              )
            )
          )
        )
      )
    );

    console2.log("Predicted address for RelayDepository", predictedAddress);

    // Verify if the contract has already been deployed
    if (_hasBeenDeployed(predictedAddress)) {
      console2.log("RelayDepository was already deployed");
      return predictedAddress;
    }

    // Deploy
    RelayDepository relayDepository = new RelayDepository{salt: salt}(
      owner,
      allocator
    );

    // Ensure the predicted and actual addresses match
    if (predictedAddress != address(relayDepository)) {
      revert IncorrectContractAddress(
        predictedAddress,
        address(relayDepository)
      );
    }

    console2.log("RelayDepository deployed");

    return address(relayDepository);
  }

  function _hasBeenDeployed(
    address addressToCheck
  ) internal view returns (bool) {
    uint256 size;
    assembly {
      size := extcodesize(addressToCheck)
    }
    return (size > 0);
  }
}
