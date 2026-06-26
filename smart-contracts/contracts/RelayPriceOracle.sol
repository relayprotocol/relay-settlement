// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
  Currency,
  IPricingOracle,
  Price
} from "./deposit-addresses/open/oracle/IPricingOracle.sol";
import {PriceOraclePrecompile} from "./precompiles/PriceOraclePrecompile.sol";

/// @title IPriceFeedAdapter
/// @author Relay Protocol
/// @notice Provider-specific adapter that verifies and decodes raw feed updates.
interface IPriceFeedAdapter {
  /// @notice Verifies a raw provider update and returns normalized price data.
  /// @param feedId Provider-specific feed identifier expected by the caller.
  /// @param updateData Opaque provider update bytes returned by the precompile.
  /// @return usdPrice USD price scaled by `usdPriceDecimals`.
  /// @return usdPriceDecimals Fixed-point precision used by `usdPrice`.
  /// @return publishTime Provider-signed Unix timestamp for the returned price.
  function decodeAndVerify(
    bytes32 feedId,
    bytes calldata updateData
  )
    external
    view
    returns (uint256 usdPrice, uint8 usdPriceDecimals, uint256 publishTime);
}

/// @title RelayPriceOracle
/// @author Relay Protocol
/// @notice Ownable currency-to-feed routing table that delegates feed price reads to the precompile.
contract RelayPriceOracle is Ownable, IPricingOracle {
  /// @notice Maximum number of currencies accepted in one price query.
  uint256 public constant MAX_PRICE_BATCH_SIZE = 32;

  /// @notice Configured route from a currency to a provider feed.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param currencyDecimals Number of decimals the currency itself uses.
  /// @param maxAgeSeconds Validity window added to the provider publish time.
  /// @param exists Whether this route has been configured.
  struct FeedRoute {
    bytes32 providerId;
    bytes32 feedId;
    uint8 currencyDecimals;
    uint32 maxAgeSeconds;
    bool exists;
  }

  /// @notice Configured feed route per currency key.
  mapping(bytes32 currencyKey => FeedRoute route) public feedRoutes;

  /// @notice Price feed adapter per provider ID.
  mapping(bytes32 providerId => address adapter) public priceFeedAdapters;

  /// @notice Emitted when a currency route is set.
  /// @param currencyKey Key derived from `(chainId, currency)`.
  /// @param chainId Identifier of the chain the currency lives on.
  /// @param currency Opaque, VM-specific encoding of the currency.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param currencyDecimals Number of decimals the currency itself uses.
  /// @param maxAgeSeconds Validity window added to the provider publish time.
  event FeedRouteSet(
    bytes32 indexed currencyKey,
    string chainId,
    bytes currency,
    bytes32 indexed providerId,
    bytes32 indexed feedId,
    uint8 currencyDecimals,
    uint32 maxAgeSeconds
  );

  /// @notice Emitted when a currency route is deleted.
  /// @param currencyKey Key derived from `(chainId, currency)`.
  /// @param chainId Identifier of the chain the currency lives on.
  /// @param currency Opaque, VM-specific encoding of the currency.
  event FeedRouteDeleted(
    bytes32 indexed currencyKey,
    string chainId,
    bytes currency
  );

  /// @notice Emitted when a provider adapter is set.
  /// @param providerId Oracle provider identifier.
  /// @param adapter Adapter that verifies and decodes provider updates.
  event PriceFeedAdapterSet(
    bytes32 indexed providerId,
    address indexed adapter
  );

  /// @notice Thrown when a route uses the zero provider ID.
  error InvalidProviderId();

  /// @notice Thrown when a route uses the zero feed ID.
  error InvalidFeedId();

  /// @notice Thrown when a provider adapter address is zero.
  error InvalidPriceFeedAdapter(address adapter);

  /// @notice Thrown when batch input arrays do not have the same length.
  error ArrayLengthMismatch(
    uint256 currenciesLength,
    uint256 providerIdsLength,
    uint256 feedIdsLength,
    uint256 currencyDecimalsLength,
    uint256 maxAgeSecondsLength
  );

  /// @notice Thrown when a currency has no configured route.
  error FeedRouteNotFound(bytes32 currencyKey);

  /// @notice Thrown when no adapter is configured for a provider.
  error PriceFeedAdapterNotFound(bytes32 providerId);

  /// @notice Thrown when a price query batch is larger than the configured cap.
  error PriceBatchTooLarge(uint256 length, uint256 maxLength);

  /// @notice Creates a new price oracle contract.
  /// @param _owner Owner that can update feed routes.
  constructor(address _owner) Ownable(_owner) {}

  /// @notice Sets or replaces the provider feed route for a currency.
  /// @param currency Currency whose USD price should route to the feed.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param currencyDecimals Number of decimals the currency itself uses.
  /// @param maxAgeSeconds Validity window added to the provider publish time.
  function setFeedRoute(
    Currency calldata currency,
    bytes32 providerId,
    bytes32 feedId,
    uint8 currencyDecimals,
    uint32 maxAgeSeconds
  ) external onlyOwner {
    _setFeedRoute(
      currency,
      providerId,
      feedId,
      currencyDecimals,
      maxAgeSeconds
    );
  }

  /// @notice Sets or replaces multiple provider feed routes.
  /// @param currencies Currencies whose USD prices should route to the feeds.
  /// @param providerIds Oracle providers that own the feed IDs.
  /// @param feedIds Provider-specific feed identifiers.
  /// @param currencyDecimals Number of decimals each currency itself uses.
  /// @param maxAgeSeconds Validity window added to each provider publish time.
  function setFeedRoutes(
    Currency[] calldata currencies,
    bytes32[] calldata providerIds,
    bytes32[] calldata feedIds,
    uint8[] calldata currencyDecimals,
    uint32[] calldata maxAgeSeconds
  ) external onlyOwner {
    uint256 length = currencies.length;
    if (
      length != providerIds.length ||
      length != feedIds.length ||
      length != currencyDecimals.length ||
      length != maxAgeSeconds.length
    ) {
      revert ArrayLengthMismatch(
        length,
        providerIds.length,
        feedIds.length,
        currencyDecimals.length,
        maxAgeSeconds.length
      );
    }

    for (uint256 i; i < length; ++i) {
      _setFeedRoute(
        currencies[i],
        providerIds[i],
        feedIds[i],
        currencyDecimals[i],
        maxAgeSeconds[i]
      );
    }
  }

  /// @notice Deletes the configured provider feed route for a currency.
  /// @param currency Currency whose route should be deleted.
  function deleteFeedRoute(Currency calldata currency) external onlyOwner {
    bytes32 key = currencyKey(currency);
    if (!feedRoutes[key].exists) {
      revert FeedRouteNotFound(key);
    }

    delete feedRoutes[key];
    emit FeedRouteDeleted(key, currency.chainId, currency.currency);
  }

  /// @notice Sets or replaces the adapter for a provider.
  /// @param providerId Oracle provider identifier.
  /// @param adapter Adapter that verifies and decodes provider updates.
  function setPriceFeedAdapter(
    bytes32 providerId,
    address adapter
  ) external onlyOwner {
    if (providerId == bytes32(0)) {
      revert InvalidProviderId();
    }
    if (adapter == address(0)) {
      revert InvalidPriceFeedAdapter(adapter);
    }

    priceFeedAdapters[providerId] = adapter;
    emit PriceFeedAdapterSet(providerId, adapter);
  }

  /// @inheritdoc IPricingOracle
  /// @dev `RelayPriceOracle` ignores `extraData`; direct callers can use the overload without it.
  function getUsdPrices(
    Currency[] calldata currencies,
    bytes calldata
  ) external view returns (Price[] memory prices) {
    prices = _getUsdPrices(currencies);
  }

  /// @notice Returns USD prices for a batch of currencies via their configured provider feeds.
  /// @param currencies Currencies whose USD prices should be returned.
  /// @return prices USD price data for `currencies`, in the same order.
  function getUsdPrices(
    Currency[] calldata currencies
  ) external view returns (Price[] memory prices) {
    prices = _getUsdPrices(currencies);
  }

  /// @notice Returns the USD price for a currency via its configured provider feed.
  /// @param currency Currency whose USD price should be returned.
  /// @return price USD price data for `currency`.
  function getUsdPrice(
    Currency calldata currency
  ) external view returns (Price memory price) {
    price = _getUsdPrice(currency);
  }

  /// @notice Returns USD prices for a batch of currencies via their configured provider feeds.
  /// @param currencies Currencies whose USD prices should be returned.
  /// @return prices USD price data for `currencies`, in the same order.
  function _getUsdPrices(
    Currency[] calldata currencies
  ) internal view returns (Price[] memory prices) {
    uint256 length = currencies.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    prices = new Price[](length);

    for (uint256 i; i < length; ++i) {
      prices[i] = _getUsdPrice(currencies[i]);
    }
  }

  /// @notice Stores a provider feed route after validating it.
  /// @param currency Currency whose USD price should route to the feed.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param currencyDecimals Number of decimals the currency itself uses.
  /// @param maxAgeSeconds Validity window added to the provider publish time.
  function _setFeedRoute(
    Currency calldata currency,
    bytes32 providerId,
    bytes32 feedId,
    uint8 currencyDecimals,
    uint32 maxAgeSeconds
  ) internal {
    if (providerId == bytes32(0)) {
      revert InvalidProviderId();
    }
    if (feedId == bytes32(0)) {
      revert InvalidFeedId();
    }

    bytes32 key = currencyKey(currency);
    feedRoutes[key] = FeedRoute({
      providerId: providerId,
      feedId: feedId,
      currencyDecimals: currencyDecimals,
      maxAgeSeconds: maxAgeSeconds,
      exists: true
    });
    emit FeedRouteSet(
      key,
      currency.chainId,
      currency.currency,
      providerId,
      feedId,
      currencyDecimals,
      maxAgeSeconds
    );
  }

  /// @notice Returns the configured USD price for a currency.
  /// @param currency Currency whose USD price should be returned.
  /// @return price USD price data for `currency`.
  function _getUsdPrice(
    Currency calldata currency
  ) internal view returns (Price memory price) {
    bytes32 key = currencyKey(currency);
    FeedRoute memory route = feedRoutes[key];
    if (!route.exists) {
      revert FeedRouteNotFound(key);
    }

    address adapter = priceFeedAdapters[route.providerId];
    if (adapter == address(0)) {
      revert PriceFeedAdapterNotFound(route.providerId);
    }

    bytes memory updateData = PriceOraclePrecompile.getFeedUpdate(
      route.providerId,
      route.feedId
    );

    (
      uint256 usdPrice,
      uint8 usdPriceDecimals,
      uint256 publishTime
    ) = IPriceFeedAdapter(adapter).decodeAndVerify(route.feedId, updateData);

    price = Price({
      usdPrice: usdPrice,
      usdPriceDecimals: usdPriceDecimals,
      currencyDecimals: route.currencyDecimals,
      expiration: publishTime + route.maxAgeSeconds
    });
  }

  /// @notice Derives the route key for a currency.
  /// @param currency Currency to key.
  /// @return key Storage key used by `feedRoutes`.
  function currencyKey(
    Currency calldata currency
  ) public pure returns (bytes32 key) {
    key = keccak256(abi.encode(currency.chainId, currency.currency));
  }
}
