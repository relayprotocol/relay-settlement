// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {Price} from "../deposit-addresses/open/oracle/IPricingOracle.sol";
import {RelayPriceOracle} from "../RelayPriceOracle.sol";
import {IFeeCalculator} from "./IFeeCalculator.sol";

/// @title RelayBpsFeeCalculator
/// @author Relay Protocol
/// @notice Default FAST_MINT fee calculator using a 1e18-scaled fraction of the USD value.
contract RelayBpsFeeCalculator is IFeeCalculator {
  // Fields

  /// @notice Oracle used to price the deposited token and requested fee currency.
  RelayPriceOracle public immutable PRICE_ORACLE;

  // Errors

  error ZeroAddress();
  error InvalidFeeBps(uint256 feeBps);
  error InvalidFeeRecipient();
  error InvalidFeePayer();

  // Constructor

  /// @notice Creates the fee calculator.
  /// @param priceOracle Address of the Relay price oracle.
  constructor(address priceOracle) {
    if (priceOracle == address(0)) {
      revert ZeroAddress();
    }
    PRICE_ORACLE = RelayPriceOracle(priceOracle);
  }

  // Public methods

  /// @inheritdoc IFeeCalculator
  /// @dev `data` is `abi.encode(uint256 feeCurrency, uint256 feeBps, address feeRecipient,
  ///      address feePayer)`.
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
    )
  {
    uint256 feeBps;
    (feeCurrency, feeBps, feeRecipient, feePayer) = abi.decode(
      data,
      (uint256, uint256, address, address)
    );
    if (feeBps > 1e18) {
      revert InvalidFeeBps(feeBps);
    }

    uint256 feeUsdValue;
    if (amount != 0 && feeBps != 0) {
      feeUsdValue = FixedPointMathLib.fullMulDiv(
        _toUsdValue(tokenId, amount),
        feeBps,
        1e18
      );
    }
    if (feeUsdValue != 0) {
      feeAmount = _fromUsdValue(feeCurrency, feeUsdValue);
    }

    if (feeAmount != 0 && feeRecipient == address(0)) {
      revert InvalidFeeRecipient();
    }
    if (feeAmount != 0 && feePayer == address(0)) {
      revert InvalidFeePayer();
    }
  }

  // Internal methods

  /// @notice Converts a raw token amount into USD scaled by 18 decimals.
  /// @return usdValue USD value scaled by 18 decimals.
  function _toUsdValue(
    uint256 tokenId,
    uint256 amount
  ) internal returns (uint256 usdValue) {
    Price memory price = PRICE_ORACLE.resolveUsdPrice(tokenId);
    usdValue = FixedPointMathLib.fullMulDiv(
      amount,
      price.usdPrice,
      10 ** uint256(price.currencyDecimals)
    );
    return _normalizeUsdDecimals(usdValue, price.usdPriceDecimals, 18);
  }

  /// @notice Converts an 18-decimal USD value into a raw fee-currency amount.
  /// @return amount Raw amount of the fee currency.
  function _fromUsdValue(
    uint256 feeCurrency,
    uint256 usdValue
  ) internal returns (uint256 amount) {
    Price memory price = PRICE_ORACLE.resolveUsdPrice(feeCurrency);
    uint256 priceScaledUsdValue = _normalizeUsdDecimals(
      usdValue,
      18,
      price.usdPriceDecimals
    );
    return
      FixedPointMathLib.fullMulDiv(
        priceScaledUsdValue,
        10 ** uint256(price.currencyDecimals),
        price.usdPrice
      );
  }

  /// @notice Normalizes a USD fixed-point value between decimal scales.
  /// @return normalized Value scaled by `toDecimals`.
  function _normalizeUsdDecimals(
    uint256 value,
    uint8 fromDecimals,
    uint8 toDecimals
  ) internal pure returns (uint256 normalized) {
    if (fromDecimals < toDecimals) {
      return value * (10 ** (toDecimals - fromDecimals));
    }
    if (fromDecimals > toDecimals) {
      return value / (10 ** (fromDecimals - toDecimals));
    }
    return value;
  }
}
