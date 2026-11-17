// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FundingPool} from "../../contracts/funding-pools/FundingPool.sol";
import {FundingPoolFactory} from "../../contracts/funding-pools/FundingPoolFactory.sol";
import {BaseTest} from "../utils/BaseTest.sol";

contract FundingPoolFactoryTest is BaseTest {
  FundingPoolFactory internal factory;

  function setUp() public override {
    super.setUp();
    factory = new FundingPoolFactory();
  }

  function test_deploysFullContractAtPredictedAddress() public {
    bytes32 salt = keccak256("primary-pool");
    address predicted = factory.predictPoolAddress(salt, owner, owner, owner);

    vm.prank(owner);
    address deployed = factory.deployPool(salt, owner, owner, owner);

    assertEq(deployed, predicted);
    assertTrue(factory.isPool(deployed));
    assertTrue(
      FundingPool(deployed).hasRole(FundingPool(deployed).ADMIN_ROLE(), owner)
    );
    assertFalse(
      FundingPool(deployed).hasRole(
        FundingPool(deployed).ADMIN_ROLE(),
        address(factory)
      )
    );
    assertGt(deployed.code.length, 1_000);
  }

  function test_poolAddressIsCallerAgnostic() public {
    bytes32 salt = bytes32(uint256(1));
    address predicted = factory.predictPoolAddress(salt, owner, owner, owner);

    vm.prank(otherAccounts[0]);
    address deployed = factory.deployPool(salt, owner, owner, owner);

    assertEq(deployed, predicted);
  }

  function test_rejectsDuplicateDeploymentAcrossCallers() public {
    bytes32 salt = bytes32(uint256(2));
    address predicted = factory.predictPoolAddress(salt, owner, owner, owner);

    vm.prank(owner);
    factory.deployPool(salt, owner, owner, owner);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPoolFactory.PoolAlreadyDeployed.selector,
        predicted
      )
    );
    vm.prank(otherAccounts[0]);
    factory.deployPool(salt, owner, owner, owner);
  }

  function test_roleAssignmentsProduceDifferentAddresses() public view {
    bytes32 salt = bytes32(uint256(3));

    assertNotEq(
      factory.predictPoolAddress(salt, owner, owner, owner),
      factory.predictPoolAddress(salt, otherAccounts[0], owner, owner)
    );
  }
}
