// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Currency, IPricingOracle, Price} from "./IPricingOracle.sol";

/// @title BasicPricingOracle
/// @author Relay Protocol
/// @notice Pricing oracle that returns prices encoded directly in `extraData`.
contract BasicPricingOracle is IPricingOracle {
  /// @notice Thrown when the decoded price count does not match the currency count.
  /// @param currencyCount Number of currencies requested
  /// @param priceCount Number of prices decoded from `extraData`
  error PriceCountMismatch(uint256 currencyCount, uint256 priceCount);

  /// @inheritdoc IPricingOracle
  function resolveUsdPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external pure returns (Price[] memory prices) {
    prices = abi.decode(extraData, (Price[]));

    if (prices.length != currencies.length) {
      revert PriceCountMismatch(currencies.length, prices.length);
    }
  }
}
