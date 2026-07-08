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
/// @param usdPrice         USD price of one whole unit of the currency — the
///                         mid (benchmark) price — scaled by
///                         `10 ** usdPriceDecimals`. The bid/ask band, when a
///                         provider exposes one, is read separately via
///                         `IBidAskOracle`.
/// @param usdPriceDecimals Fixed-point precision of `usdPrice`
/// @param currencyDecimals Number of decimals the currency itself uses
/// @param expiration       Unix timestamp after which this price must not be used
struct Price {
  uint256 usdPrice;
  uint8 usdPriceDecimals;
  uint8 currencyDecimals;
  uint256 expiration;
}

/// @notice Mid price together with the bid/ask band for one unit of a currency.
/// @dev Returned by `IBidAskOracle` for consumers (eg. an AMM) that need the
///      market liquidity distribution, not just the mid. Keeping this separate
///      from `Price` leaves the common mid-only path untouched.
/// @param midPrice         Mid (benchmark) price, scaled by `10 ** usdPriceDecimals`
/// @param bidPrice         Best bid price, scaled by `10 ** usdPriceDecimals`,
///                         or `0` when no bid/ask is available. Invariant:
///                         either `bidPrice == askPrice == 0` (unavailable) or
///                         `bidPrice <= midPrice <= askPrice`. Consumers must
///                         null-check before using `bidPrice`/`askPrice`.
/// @param askPrice         Best ask price, scaled by `10 ** usdPriceDecimals`,
///                         or `0` when no bid/ask is available (see `bidPrice`)
/// @param usdPriceDecimals Fixed-point precision of `midPrice`, `bidPrice` and `askPrice`
/// @param currencyDecimals Number of decimals the currency itself uses
/// @param expiration       Unix timestamp after which this price must not be used
struct BidAsk {
  uint256 midPrice;
  uint256 bidPrice;
  uint256 askPrice;
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
  ///
  /// This function is intentionally **not** `view`: an implementation may
  /// verify the prices on-chain in a state-changing, fee-paying call (eg.
  /// Chainlink Data Streams `VerifierProxy.verify`, which checks DON
  /// signatures and routes a fee). Implementations that need no side effects
  /// (mocks, signed-price or pre-encoded oracles) may still declare the
  /// stricter `view`/`pure` mutability and satisfy this interface. Callers
  /// must therefore reach prices through a regular call, not a `staticcall`.
  /// @param currencies Currencies whose USD prices should be returned
  /// @param extraData Opaque data passed through from the caller
  /// @return prices USD prices for `currencies`, in the same order
  function resolveUsdPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external returns (Price[] memory prices);
}

/// @title IBidAskOracle
/// @author Relay Protocol
/// @notice Optional oracle capability that exposes the bid/ask band alongside
///         the mid price, for consumers (eg. an AMM) that need the market
///         liquidity distribution. Only oracles backed by providers that carry
///         a band (eg. Chainlink Data Streams) implement this; the common
///         mid-only path stays on `IPricingOracle`.
interface IBidAskOracle {
  /// @notice Returns the mid price and bid/ask band for a batch of currencies.
  /// @dev Like `IPricingOracle.resolveUsdPrices`, this is intentionally not
  ///      `view` (it may verify on-chain in a fee-paying call) and resolves the
  ///      band in the same verification, so a consumer needs only one call.
  /// @param currencies Currencies whose bid/ask bands should be returned
  /// @param extraData Opaque data passed through from the caller
  /// @return bidAsks Mid + bid/ask for `currencies`, in the same order
  function resolveBidAskPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external returns (BidAsk[] memory bidAsks);
}
