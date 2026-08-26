// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams} from "../RelayAllocator.sol";

/// @title WithdrawParams
/// @author Relay Protocol
/// @notice Canonical hashing of the parameters passed to
///         `IPayloadBuilder.buildPayload`, shared by the payload builders that
///         gate on gas payments and the `WithdrawGasPayer` contract that
///         records them. Keeping the encoding in one place guarantees the
///         payer and the builders can never drift apart.
/// @dev The library only has internal functions, so it is inlined into the
///      calling contracts at compile time — it is never deployed or linked
///      separately.
library WithdrawParams {
  /// @notice Hashes the exact tuple the allocator passes to a payload builder
  /// @param chainId The destination chain id
  /// @param depository The encoded depository address
  /// @param params Payload builder parameters
  /// @return withdrawParamsHash Hash identifying the withdrawal parameters
  function hash(
    string memory chainId,
    bytes memory depository,
    BuildPayloadParams memory params
  ) internal pure returns (bytes32 withdrawParamsHash) {
    return keccak256(abi.encode(chainId, depository, params));
  }
}

/// @title IWithdrawGasPayer
/// @author Relay Protocol
/// @notice Minimal interface for querying gas payments on `WithdrawGasPayer`
interface IWithdrawGasPayer {
  /// @notice Returns the amount burned for a recorded gas payment (0 = unpaid)
  /// @param withdrawParamsHash Hash of the withdrawal parameters
  /// @return amount Amount burned as the gas payment, zero when unpaid
  function gasPayments(
    bytes32 withdrawParamsHash
  ) external view returns (uint256 amount);
}

/// @title GasPaidPayloadBuilder
/// @author Relay Protocol
/// @notice Mixin for payload builders whose withdrawals require the withdrawer
///         to pre-pay fees spent by a shared allocator or depository balance.
/// @dev Withdrawals through Circle Gateway and on chains like TON and XRPL
///      spend allocator or depository funds on fees, which would otherwise
///      drain balances backing other users' deposits. `WithdrawGasPayer` burns
///      the withdrawer's hub funds and records the payment keyed by the withdraw
///      params hash; builders inheriting this contract refuse to build a payload
///      exists. Builders are responsible for applying any VM-specific fee
///      bounds using their own configuration.
abstract contract GasPaidPayloadBuilder {
  /// @notice Thrown when no gas payment is recorded for the withdraw parameters
  /// @param withdrawParamsHash Hash of the unpaid withdrawal parameters
  error GasNotPaid(bytes32 withdrawParamsHash);

  /// @notice WithdrawGasPayer contract whose payments authorize payload builds
  address public immutable GAS_PAYER;

  /// @notice Binds the builder to a gas payer
  /// @param gasPayer WithdrawGasPayer contract address
  constructor(address gasPayer) {
    GAS_PAYER = gasPayer;
  }

  /// @notice Reverts unless a gas payment is recorded for the parameters
  /// @param chainId The destination chain id
  /// @param depository The encoded depository address
  /// @param params Payload builder parameters
  /// @return paidAmount Amount burned as the gas payment, so builders can
  ///         bound the fee the depository actually spends by what was pre-paid
  function _requireGasPaid(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) internal view returns (uint256 paidAmount) {
    bytes32 withdrawParamsHash = WithdrawParams.hash(
      chainId,
      depository,
      params
    );
    paidAmount = IWithdrawGasPayer(GAS_PAYER).gasPayments(withdrawParamsHash);
    if (paidAmount == 0) {
      revert GasNotPaid(withdrawParamsHash);
    }
  }
}
