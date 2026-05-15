// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Identifies a currency on a given chain.
/// @param chainId Identifier of the chain the currency lives on
/// @param currency Opaque, VM-specific encoding of the currency
struct Currency {
  string chainId;
  bytes currency;
}

/// @notice A USD price for one whole unit of a currency, together with the
///         currency's own decimals and the price's expiration.
///
///         Two independent decimal scales are tracked, and they must not be
///         confused:
///
///         - `currencyDecimals` describes the *currency* itself (eg. 18 for
///           ETH, 6 for USDC). It is used to interpret raw on-chain balances
///           as fractional units of the currency.
///         - `usdPriceDecimals` describes the *fixed-point precision* of
///           `usdPrice` (eg. 8 means `usdPrice` is expressed in 1e-8 USD).
///
///         To convert a raw currency amount `rawAmount` into USD scaled by
///         `10 ** usdPriceDecimals`:
///
///             usd = rawAmount * usdPrice / (10 ** currencyDecimals)
///
/// @param usdPrice         USD price of one whole unit of the currency,
///                         scaled by `10 ** usdPriceDecimals`
/// @param usdPriceDecimals Fixed-point precision of `usdPrice`
/// @param currencyDecimals Number of decimals the currency itself uses
/// @param expiration       Unix timestamp after which this price must not be used
struct Price {
  uint256 usdPrice;
  uint8 usdPriceDecimals;
  uint8 currencyDecimals;
  uint256 expiration;
}

/// @title IPricingOracle
/// @author Relay Protocol
/// @notice Interface for accessing USD prices for currencies across chains.
interface IPricingOracle {
  /// @notice Returns USD prices for a batch of currencies.
  /// @dev `extraData` is passed through from the caller verbatim to allow
  /// the oracle implementation to authenticate, version or otherwise
  /// parameterize the response (eg. signed price attestations).
  /// @param currencies Currencies whose USD prices should be returned
  /// @param extraData Opaque data passed through from the caller
  /// @return prices USD prices for `currencies`, in the same order
  function getUsdPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external view returns (Price[] memory prices);
}
