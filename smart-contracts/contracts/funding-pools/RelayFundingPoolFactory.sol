// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {RelayFundingPool} from "./RelayFundingPool.sol";

/// @title RelayFundingPoolFactory
/// @author Relay Protocol
/// @notice Deterministically deploys independent, immutable funding pool contracts
/// @dev Pool addresses depend only on the salt and the role configuration
///      (admin, withdrawer, resolver — hashed into the init code), never on the
///      caller, so any wallet predicts and reproduces the same address. This is
///      front-run safe: deploying first at a predicted address requires the
///      identical init code, which yields the byte-identical pool.
contract RelayFundingPoolFactory {
  /// @notice Records contracts deployed by this factory
  mapping(address => bool) public isPool;

  /// @notice Emitted when a pool is deployed
  event PoolDeployed(
    address indexed deployer,
    address indexed pool,
    bytes32 indexed salt
  );

  error PoolAlreadyDeployed(address pool);

  /// @notice Deploys a pool at the caller-agnostic address for this salt and
  ///         role configuration
  /// @return pool Address of the deployed pool
  function deployPool(
    bytes32 salt,
    address admin,
    address withdrawer,
    address resolver
  ) external returns (address pool) {
    pool = predictPoolAddress(salt, admin, withdrawer, resolver);
    if (pool.code.length != 0) {
      revert PoolAlreadyDeployed(pool);
    }

    pool = address(
      new RelayFundingPool{salt: salt}(admin, withdrawer, resolver)
    );
    isPool[pool] = true;
    emit PoolDeployed(msg.sender, pool, salt);
  }

  /// @notice Predicts the address of a pool before deployment
  /// @return pool Predicted pool address
  function predictPoolAddress(
    bytes32 salt,
    address admin,
    address withdrawer,
    address resolver
  ) public view returns (address pool) {
    bytes32 initCodeHash = keccak256(
      abi.encodePacked(
        type(RelayFundingPool).creationCode,
        abi.encode(admin, withdrawer, resolver)
      )
    );
    pool = Create2.computeAddress(salt, initCodeHash, address(this));
  }
}
