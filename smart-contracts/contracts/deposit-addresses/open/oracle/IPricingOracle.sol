// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Identifies a currency on a given chain.
/// @param chainId Identifier of the chain the currency lives on
/// @param currency Opaque, VM-specific encoding of the currency
struct Currency {
  string chainId;
  bytes currency;
}

/// @notice A USD price together with its fixed-point precision and expiration.
/// @param amount USD price expressed in units of `10 ** -decimals` dollars
/// @param decimals Number of decimals used to scale `amount`
/// @param expiration Unix timestamp after which this price should no longer be used
struct Price {
  uint256 amount;
  uint8 decimals;
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
