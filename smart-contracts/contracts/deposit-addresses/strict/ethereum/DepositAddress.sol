// SPDX-License-Identifier: MIT
// ABOUTME: EIP-1167 proxy implementation for counterfactual deposit addresses.
// ABOUTME: Sweeps ERC20 and native funds to a RelayDepository on behalf of a depositor.
pragma solidity ^0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {RelayDepository} from "../../../depository/RelayDepository.sol";

/// @title DepositAddress
/// @author Relay Protocol
/// @notice Implementation contract used via EIP-1167 minimal proxies to sweep
///         deposited funds into a RelayDepository
/// @dev The depository is stored as an immutable in the implementation bytecode,
///      which is correctly read through DELEGATECALL from EIP-1167 proxies
contract DepositAddress {
  /// @notice The depository contract that receives all swept funds
  address public immutable DEPOSITORY;

  /// @notice The factory authorized to call sweep
  address public immutable FACTORY;

  /// @notice Revert when caller is not the factory
  error OnlyFactory();

  /// @notice Deploy a new sweeper implementation targeting a fixed depository
  /// @dev msg.sender becomes the FACTORY — must be deployed by DepositAddressFactory
  constructor(address _depository) {
    DEPOSITORY = _depository;
    FACTORY = msg.sender;
  }

  /// @notice Sweep a token balance from this contract to the depository
  /// @param token The token to sweep (address(0) for native ETH)
  /// @param depositor The address to credit in the depository
  /// @param orderId The deposit identifier
  function sweep(address token, address depositor, bytes32 orderId) external {
    if (msg.sender != FACTORY) revert OnlyFactory();
    if (token == address(0)) {
      uint256 balance = address(this).balance;
      if (balance > 0) {
        RelayDepository(payable(DEPOSITORY)).depositNative{value: balance}(
          depositor,
          orderId
        );
      }
    } else {
      uint256 balance = SafeTransferLib.balanceOf(token, address(this));
      if (balance > 0) {
        SafeTransferLib.safeApprove(token, DEPOSITORY, balance);
        RelayDepository(payable(DEPOSITORY)).depositErc20(
          depositor,
          token,
          balance,
          orderId
        );
      }
    }
  }

  /// @notice Accept native ETH transfers (prevents griefing on early deployment)
  receive() external payable {}
}
