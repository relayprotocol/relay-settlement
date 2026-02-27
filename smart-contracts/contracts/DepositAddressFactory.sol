// SPDX-License-Identifier: MIT
// ABOUTME: Factory for deterministic deposit addresses using EIP-1167 minimal proxies.
// ABOUTME: Computes addresses before deployment and sweeps deposited funds to a depository.
pragma solidity ^0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";
import {IDepositAddressFactory} from "./interfaces/IDepositAddressFactory.sol";
import {DepositAddress} from "./DepositAddress.sol";

/// @title DepositAddressFactory
/// @author Relay Protocol
/// @notice Deploys deterministic EIP-1167 minimal proxies for deposit collection
///         and sweeps funds to a hardcoded depository
contract DepositAddressFactory is IDepositAddressFactory {
  /// @notice The depository contract that receives all swept funds
  address public immutable DEPOSITORY;

  /// @notice The DepositAddress implementation used by all proxies
  address public immutable IMPLEMENTATION;

  /// @notice Deploy a new factory with a fixed depository
  /// @dev Deploys the DepositAddress implementation internally so it trusts this factory as msg.sender
  constructor(address _depository) {
    DEPOSITORY = _depository;
    IMPLEMENTATION = address(new DepositAddress(_depository));
  }

  /// @inheritdoc IDepositAddressFactory
  function computeDepositAddress(
    bytes32 orderId,
    address depositor
  ) external view returns (address) {
    bytes32 salt = _salt(orderId, depositor);
    return
      LibClone.predictDeterministicAddress(IMPLEMENTATION, salt, address(this));
  }

  /// @inheritdoc IDepositAddressFactory
  function sweep(
    bytes32 orderId,
    address depositor,
    address[] calldata tokens
  ) external {
    bytes32 salt = _salt(orderId, depositor);
    address proxy = LibClone.predictDeterministicAddress(
      IMPLEMENTATION,
      salt,
      address(this)
    );

    // Deploy the proxy if it hasn't been deployed yet
    if (proxy.code.length == 0) {
      proxy = LibClone.cloneDeterministic(IMPLEMENTATION, salt);
      emit ProxyDeployed(orderId, proxy);
    }

    _sweepProxy(proxy, depositor, tokens, orderId);
  }

  /// @notice Compute the CREATE2 salt from orderId and depositor
  /// @return The keccak256 hash of the packed orderId and depositor
  function _salt(
    bytes32 orderId,
    address depositor
  ) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(orderId, depositor));
  }

  /// @notice Sweep all tokens from a proxy to the depository
  function _sweepProxy(
    address proxy,
    address depositor,
    address[] calldata tokens,
    bytes32 orderId
  ) internal {
    for (uint256 i; i < tokens.length; ++i) {
      DepositAddress(payable(proxy)).sweep(tokens[i], depositor, orderId);
    }
  }
}
