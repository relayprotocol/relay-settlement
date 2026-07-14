// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFeeCalculator
/// @author Relay Protocol
/// @notice Computes the fee for RelayOracleV2 FAST_MINT actions.
interface IFeeCalculator {
  /// @notice Compute the fee amount and recipient.
  /// @param tokenId The token id for the fast mint.
  /// @param amount The gross deposit amount.
  /// @param data Opaque action-provided data for this fee calculator.
  /// @return feeCurrency The token id for the fee transfer.
  /// @return feeAmount The amount transferred to the fee recipient.
  /// @return feeRecipient The address receiving the fee amount.
  /// @return feePayer The address paying the fee.
  function calculateFee(
    uint256 tokenId,
    uint256 amount,
    bytes calldata data
  )
    external
    returns (
      uint256 feeCurrency,
      uint256 feeAmount,
      address feeRecipient,
      address feePayer
    );
}
