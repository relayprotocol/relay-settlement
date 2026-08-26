// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
  BidAsk,
  Currency,
  IBidAskOracle,
  IPricingOracle,
  Price
} from "./deposit-addresses/oracle/IPricingOracle.sol";
import {ERC20View} from "./ERC20View.sol";
import {PriceOraclePrecompile} from "./precompiles/PriceOraclePrecompile.sol";
import {Utils} from "./Utils.sol";

/// @title IPriceFeedAdapter
/// @author Relay Protocol
/// @notice Provider-specific adapter that verifies and decodes raw feed updates.
interface IPriceFeedAdapter {
  /// @notice Thrown when the configured oracle address is invalid.
  error InvalidOracle(address oracle);

  /// @notice Thrown when a caller other than the bound oracle requests verification.
  error UnauthorizedCaller(address caller);

  /// @notice RelayPriceOracle authorized to call `decodeAndVerify`.
  /// @return oracleAddress Authorized RelayPriceOracle address.
  function ORACLE() external view returns (address);

  /// @notice Verifies a raw provider update and returns normalized price data.
  /// @dev Intentionally not `view`: an adapter may verify the update on-chain
  ///      via a state-changing, fee-paying call (eg. Chainlink Data Streams
  ///      `VerifierProxy.verify`, which checks DON signatures). Adapters that
  ///      only decode and structurally validate may declare the stricter
  ///      `view`/`pure` mutability and still satisfy this interface.
  /// @param feedId Provider-specific feed identifier expected by the caller.
  /// @param updateData Opaque provider update bytes returned by the precompile.
  /// @return usdPrice USD (mid) price scaled by `usdPriceDecimals`.
  /// @return bid Best bid price scaled by `usdPriceDecimals`, or `0` when the
  ///         provider has no bid/ask available.
  /// @return ask Best ask price scaled by `usdPriceDecimals`, or `0` when the
  ///         provider has no bid/ask available.
  /// @return usdPriceDecimals Fixed-point precision used by `usdPrice`, `bid` and `ask`.
  /// @return publishTime Provider-signed Unix timestamp for the returned price.
  function decodeAndVerify(
    bytes32 feedId,
    bytes calldata updateData
  )
    external
    returns (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    );
}

/// @title RelayPriceOracle
/// @author Relay Protocol
/// @notice Ownable currency-to-feed routing table that delegates feed price reads to the precompile.
contract RelayPriceOracle is Ownable, IPricingOracle, IBidAskOracle {
  /// @notice Maximum number of currencies accepted in one price query.
  uint256 public constant MAX_PRICE_BATCH_SIZE = 32;

  /// @notice Hard upper bound for a provider's future publish-time allowance.
  uint32 public constant MAX_FUTURE_SECONDS_UPPER_BOUND = 60;

  /// @notice Hard upper bound for a route's price freshness window.
  uint32 public constant MAX_AGE_SECONDS_UPPER_BOUND = 300;

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

  /// @notice Configured feed route per Hub token id.
  mapping(uint256 tokenId => FeedRoute route) public feedRoutes;

  /// @notice Price feed adapter per provider ID.
  mapping(bytes32 providerId => address adapter) public priceFeedAdapters;

  /// @notice Maximum future publish-time allowance per provider ID.
  mapping(bytes32 providerId => uint32 maxFutureSeconds)
    public providerMaxFutureSeconds;

  /// @notice Monotonic publish time cached per provider feed, in Unix seconds.
  mapping(bytes32 providerId => mapping(bytes32 feedId => uint256 publishTime))
    public cachedPublishTimes;

  /// @notice Emitted when a currency route is set.
  /// @param tokenId Hub token id derived from `(chainId, currency)`.
  /// @param chainId Identifier of the chain the currency lives on.
  /// @param currency Opaque, VM-specific encoding of the currency.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param currencyDecimals Number of decimals the currency itself uses.
  /// @param maxAgeSeconds Validity window added to the provider publish time.
  event FeedRouteSet(
    uint256 indexed tokenId,
    string chainId,
    bytes currency,
    bytes32 indexed providerId,
    bytes32 indexed feedId,
    uint8 currencyDecimals,
    uint32 maxAgeSeconds
  );

  /// @notice Emitted when a currency route is deleted.
  /// @param tokenId Hub token id derived from `(chainId, currency)`.
  /// @param chainId Identifier of the chain the currency lives on.
  /// @param currency Opaque, VM-specific encoding of the currency.
  event FeedRouteDeleted(
    uint256 indexed tokenId,
    string chainId,
    bytes currency
  );

  /// @notice Emitted when a provider adapter is set.
  /// @param providerId Oracle provider identifier.
  /// @param adapter Adapter that verifies and decodes provider updates.
  /// @param maxFutureSeconds Maximum seconds a publish time may be ahead of the block timestamp.
  event PriceFeedAdapterSet(
    bytes32 indexed providerId,
    address indexed adapter,
    uint32 maxFutureSeconds
  );

  /// @notice Thrown when a route uses the zero provider ID.
  error InvalidProviderId();

  /// @notice Thrown when a route uses the zero feed ID.
  error InvalidFeedId();

  /// @notice Thrown when a provider adapter address is zero.
  error InvalidPriceFeedAdapter(address adapter);

  /// @notice Thrown when an adapter is not bound to this oracle.
  error InvalidPriceFeedAdapterOracle(
    address adapter,
    address expectedOracle,
    address actualOracle
  );

  /// @notice Thrown when a provider future-time allowance exceeds the hard cap.
  error InvalidMaxFutureSeconds(
    uint32 maxFutureSeconds,
    uint32 maxFutureSecondsUpperBound
  );

  /// @notice Thrown when a route freshness window exceeds the hard cap.
  error InvalidMaxAgeSeconds(
    uint32 maxAgeSeconds,
    uint32 maxAgeSecondsUpperBound
  );

  /// @notice Thrown when batch input arrays do not have the same length.
  error ArrayLengthMismatch(
    uint256 currenciesLength,
    uint256 providerIdsLength,
    uint256 feedIdsLength,
    uint256 currencyDecimalsLength,
    uint256 maxAgeSecondsLength
  );

  /// @notice Thrown when a currency has no configured route.
  error FeedRouteNotFound(uint256 tokenId);

  /// @notice Thrown when no adapter is configured for a provider.
  error PriceFeedAdapterNotFound(bytes32 providerId);

  /// @notice Thrown when a price query batch is larger than the configured cap.
  error PriceBatchTooLarge(uint256 length, uint256 maxLength);

  /// @notice Thrown when a resolved price is past its `maxAgeSeconds` window.
  /// @dev Distinct from the adapter's `ReportExpired`, which guards the
  ///      provider report's own expiry; this guards the per-route freshness
  ///      window (`publishTime + maxAgeSeconds`).
  /// @param expiration Timestamp after which the price must not be used.
  /// @param blockTimestamp Current block timestamp.
  error PriceExpired(uint256 expiration, uint256 blockTimestamp);

  /// @notice Thrown when a provider publish time is too far ahead of the block timestamp.
  /// @param publishTime Provider-signed Unix timestamp for the price.
  /// @param maxPublishTime Latest publish time allowed by the provider configuration.
  error PriceTimestampTooFarInFuture(
    uint256 publishTime,
    uint256 maxPublishTime
  );

  /// @notice Thrown when an adapter returns the zero publish time.
  error InvalidPublishTime();

  /// @notice Thrown when a feed's publish time moves below its latest accepted value.
  /// @param providerId Oracle provider that owns the feed ID.
  /// @param feedId Provider-specific feed identifier.
  /// @param publishTime Publish time returned by the adapter.
  /// @param cachedPublishTime Monotonic publish time cached for the feed.
  error PriceTimestampRollback(
    bytes32 providerId,
    bytes32 feedId,
    uint256 publishTime,
    uint256 cachedPublishTime
  );

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
    uint256 tokenId = currencyToTokenId(currency);
    if (!feedRoutes[tokenId].exists) {
      revert FeedRouteNotFound(tokenId);
    }

    delete feedRoutes[tokenId];
    emit FeedRouteDeleted(tokenId, currency.chainId, currency.currency);
  }

  /// @notice Sets or replaces a provider adapter and its future-time allowance.
  /// @param providerId Oracle provider identifier.
  /// @param adapter Adapter that verifies and decodes provider updates.
  /// @param maxFutureSeconds Maximum seconds a publish time may be ahead of the block timestamp.
  function setPriceFeedAdapter(
    bytes32 providerId,
    address adapter,
    uint32 maxFutureSeconds
  ) external onlyOwner {
    if (providerId == bytes32(0)) {
      revert InvalidProviderId();
    }
    if (adapter == address(0)) {
      revert InvalidPriceFeedAdapter(adapter);
    }
    (bool success, bytes memory result) = adapter.staticcall(
      abi.encodeWithSelector(IPriceFeedAdapter.ORACLE.selector)
    );
    if (!success || result.length != 32) {
      revert InvalidPriceFeedAdapter(adapter);
    }
    uint256 encodedOracle = abi.decode(result, (uint256));
    if (encodedOracle > type(uint160).max) {
      revert InvalidPriceFeedAdapter(adapter);
    }
    address adapterOracle = address(uint160(encodedOracle));
    if (adapterOracle != address(this)) {
      revert InvalidPriceFeedAdapterOracle(
        adapter,
        address(this),
        adapterOracle
      );
    }
    if (maxFutureSeconds > MAX_FUTURE_SECONDS_UPPER_BOUND) {
      revert InvalidMaxFutureSeconds(
        maxFutureSeconds,
        MAX_FUTURE_SECONDS_UPPER_BOUND
      );
    }

    priceFeedAdapters[providerId] = adapter;
    providerMaxFutureSeconds[providerId] = maxFutureSeconds;
    emit PriceFeedAdapterSet(providerId, adapter, maxFutureSeconds);
  }

  /// @inheritdoc IPricingOracle
  /// @dev `RelayPriceOracle` ignores `extraData`; direct callers can use the overload without it.
  function resolveUsdPrices(
    Currency[] calldata currencies,
    bytes calldata
  ) external returns (Price[] memory prices) {
    prices = _resolveUsdPrices(currencies);
  }

  /// @notice Returns USD prices for a batch of currencies via their configured provider feeds.
  /// @param currencies Currencies whose USD prices should be returned.
  /// @return prices USD price data for `currencies`, in the same order.
  function resolveUsdPrices(
    Currency[] calldata currencies
  ) external returns (Price[] memory prices) {
    prices = _resolveUsdPrices(currencies);
  }

  /// @notice Returns the USD price for a currency via its configured provider feed.
  /// @param currency Currency whose USD price should be returned.
  /// @return price USD price data for `currency`.
  function resolveUsdPrice(
    Currency calldata currency
  ) external returns (Price memory price) {
    price = _resolveUsdPrice(currency);
  }

  /// @notice Returns USD prices for a batch of Hub token ids via their configured provider feeds.
  /// @param tokenIds Hub token ids whose USD prices should be returned.
  /// @return prices USD price data for `tokenIds`, in the same order.
  function resolveUsdPrices(
    uint256[] calldata tokenIds
  ) external returns (Price[] memory prices) {
    prices = _resolveUsdPrices(tokenIds);
  }

  /// @notice Returns the USD price for a Hub token id via its configured provider feed.
  /// @param tokenId Hub token id whose USD price should be returned.
  /// @return price USD price data for `tokenId`.
  function resolveUsdPrice(
    uint256 tokenId
  ) external returns (Price memory price) {
    price = _resolveUsdPrice(tokenId);
  }

  /// @notice Returns USD prices for a batch of ERC20View contracts via their token ids.
  /// @param erc20Views ERC20View contracts whose USD prices should be returned.
  /// @return prices USD price data for `erc20Views`, in the same order.
  function resolveUsdPrices(
    address[] calldata erc20Views
  ) external returns (Price[] memory prices) {
    prices = _resolveUsdPrices(erc20Views);
  }

  /// @notice Returns the USD price for an ERC20View contract via its token id.
  /// @param erc20View ERC20View contract whose USD price should be returned.
  /// @return price USD price data for `erc20View`.
  function resolveUsdPrice(
    address erc20View
  ) external returns (Price memory price) {
    price = _resolveUsdPrice(ERC20View(erc20View).tokenId());
  }

  /// @inheritdoc IBidAskOracle
  /// @dev `RelayPriceOracle` ignores `extraData`; direct callers can use the overload without it.
  function resolveBidAskPrices(
    Currency[] calldata currencies,
    bytes calldata
  ) external returns (BidAsk[] memory bidAsks) {
    bidAsks = _resolveBidAskPrices(currencies);
  }

  /// @notice Returns the mid + bid/ask band for a batch of currencies via their configured feeds.
  /// @param currencies Currencies whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `currencies`, in the same order.
  function resolveBidAskPrices(
    Currency[] calldata currencies
  ) external returns (BidAsk[] memory bidAsks) {
    bidAsks = _resolveBidAskPrices(currencies);
  }

  /// @notice Returns the mid + bid/ask band for a currency via its configured feed.
  /// @param currency Currency whose bid/ask band should be returned.
  /// @return bidAsk Mid + bid/ask data for `currency`.
  function resolveBidAskPrice(
    Currency calldata currency
  ) external returns (BidAsk memory bidAsk) {
    bidAsk = _resolveBidAskPrice(currency);
  }

  /// @notice Returns the mid + bid/ask band for a batch of Hub token ids via their configured feeds.
  /// @param tokenIds Hub token ids whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `tokenIds`, in the same order.
  function resolveBidAskPrices(
    uint256[] calldata tokenIds
  ) external returns (BidAsk[] memory bidAsks) {
    bidAsks = _resolveBidAskPrices(tokenIds);
  }

  /// @notice Returns the mid + bid/ask band for a Hub token id via its configured feed.
  /// @param tokenId Hub token id whose bid/ask band should be returned.
  /// @return bidAsk Mid + bid/ask data for `tokenId`.
  function resolveBidAskPrice(
    uint256 tokenId
  ) external returns (BidAsk memory bidAsk) {
    bidAsk = _resolveBidAskPrice(tokenId);
  }

  /// @notice Returns the mid + bid/ask band for a batch of ERC20View contracts via their token ids.
  /// @param erc20Views ERC20View contracts whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `erc20Views`, in the same order.
  function resolveBidAskPrices(
    address[] calldata erc20Views
  ) external returns (BidAsk[] memory bidAsks) {
    bidAsks = _resolveBidAskPrices(erc20Views);
  }

  /// @notice Returns the mid + bid/ask band for an ERC20View contract via its token id.
  /// @param erc20View ERC20View contract whose bid/ask band should be returned.
  /// @return bidAsk Mid + bid/ask data for `erc20View`.
  function resolveBidAskPrice(
    address erc20View
  ) external returns (BidAsk memory bidAsk) {
    bidAsk = _resolveBidAskPrice(ERC20View(erc20View).tokenId());
  }

  /// @notice Returns USD prices for a batch of currencies via their configured provider feeds.
  /// @param currencies Currencies whose USD prices should be returned.
  /// @return prices USD price data for `currencies`, in the same order.
  function _resolveUsdPrices(
    Currency[] calldata currencies
  ) internal returns (Price[] memory prices) {
    uint256 length = currencies.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    prices = new Price[](length);

    for (uint256 i; i < length; ++i) {
      prices[i] = _resolveUsdPrice(currencyToTokenId(currencies[i]));
    }
  }

  /// @notice Returns USD prices for a batch of Hub token ids via their configured provider feeds.
  /// @param tokenIds Hub token ids whose USD prices should be returned.
  /// @return prices USD price data for `tokenIds`, in the same order.
  function _resolveUsdPrices(
    uint256[] calldata tokenIds
  ) internal returns (Price[] memory prices) {
    uint256 length = tokenIds.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    prices = new Price[](length);

    for (uint256 i; i < length; ++i) {
      prices[i] = _resolveUsdPrice(tokenIds[i]);
    }
  }

  /// @notice Returns USD prices for a batch of ERC20View contracts via their token ids.
  /// @param erc20Views ERC20View contracts whose USD prices should be returned.
  /// @return prices USD price data for `erc20Views`, in the same order.
  function _resolveUsdPrices(
    address[] calldata erc20Views
  ) internal returns (Price[] memory prices) {
    uint256 length = erc20Views.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    prices = new Price[](length);

    for (uint256 i; i < length; ++i) {
      prices[i] = _resolveUsdPrice(ERC20View(erc20Views[i]).tokenId());
    }
  }

  /// @notice Returns the mid + bid/ask band for a batch of currencies via their configured feeds.
  /// @param currencies Currencies whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `currencies`, in the same order.
  function _resolveBidAskPrices(
    Currency[] calldata currencies
  ) internal returns (BidAsk[] memory bidAsks) {
    uint256 length = currencies.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    bidAsks = new BidAsk[](length);

    for (uint256 i; i < length; ++i) {
      bidAsks[i] = _resolveBidAskPrice(currencyToTokenId(currencies[i]));
    }
  }

  /// @notice Returns the mid + bid/ask band for a batch of Hub token ids via their configured feeds.
  /// @param tokenIds Hub token ids whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `tokenIds`, in the same order.
  function _resolveBidAskPrices(
    uint256[] calldata tokenIds
  ) internal returns (BidAsk[] memory bidAsks) {
    uint256 length = tokenIds.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    bidAsks = new BidAsk[](length);

    for (uint256 i; i < length; ++i) {
      bidAsks[i] = _resolveBidAskPrice(tokenIds[i]);
    }
  }

  /// @notice Returns the mid + bid/ask band for a batch of ERC20View contracts via their token ids.
  /// @param erc20Views ERC20View contracts whose bid/ask bands should be returned.
  /// @return bidAsks Mid + bid/ask data for `erc20Views`, in the same order.
  function _resolveBidAskPrices(
    address[] calldata erc20Views
  ) internal returns (BidAsk[] memory bidAsks) {
    uint256 length = erc20Views.length;
    if (length > MAX_PRICE_BATCH_SIZE) {
      revert PriceBatchTooLarge(length, MAX_PRICE_BATCH_SIZE);
    }

    bidAsks = new BidAsk[](length);

    for (uint256 i; i < length; ++i) {
      bidAsks[i] = _resolveBidAskPrice(ERC20View(erc20Views[i]).tokenId());
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
    if (maxAgeSeconds > MAX_AGE_SECONDS_UPPER_BOUND) {
      revert InvalidMaxAgeSeconds(maxAgeSeconds, MAX_AGE_SECONDS_UPPER_BOUND);
    }

    uint256 tokenId = currencyToTokenId(currency);
    feedRoutes[tokenId] = FeedRoute({
      providerId: providerId,
      feedId: feedId,
      currencyDecimals: currencyDecimals,
      maxAgeSeconds: maxAgeSeconds,
      exists: true
    });
    emit FeedRouteSet(
      tokenId,
      currency.chainId,
      currency.currency,
      providerId,
      feedId,
      currencyDecimals,
      maxAgeSeconds
    );
  }

  /// @notice Resolves a token id's feed: routes it, reads the precompile, and
  ///         verifies/decodes the provider update into normalized fields.
  /// @param tokenId Hub token id whose feed should be resolved.
  /// @return usdPrice Mid (benchmark) price scaled by `usdPriceDecimals`.
  /// @return bid Best bid scaled by `usdPriceDecimals`, or `0` if unavailable.
  /// @return ask Best ask scaled by `usdPriceDecimals`, or `0` if unavailable.
  /// @return usdPriceDecimals Fixed-point precision of `usdPrice`, `bid` and `ask`.
  /// @return currencyDecimals Number of decimals the currency itself uses.
  /// @return publishTime Unix timestamp when the price was published.
  /// @return expiration Unix timestamp after which the price must not be used.
  function _resolveFeed(
    uint256 tokenId
  )
    internal
    returns (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint8 currencyDecimals,
      uint256 publishTime,
      uint256 expiration
    )
  {
    FeedRoute memory route = feedRoutes[tokenId];
    if (!route.exists) {
      revert FeedRouteNotFound(tokenId);
    }

    address adapter = priceFeedAdapters[route.providerId];
    if (adapter == address(0)) {
      revert PriceFeedAdapterNotFound(route.providerId);
    }

    bytes memory updateData = PriceOraclePrecompile.getFeedUpdate(
      route.providerId,
      route.feedId
    );

    (usdPrice, bid, ask, usdPriceDecimals, publishTime) = IPriceFeedAdapter(
      adapter
    ).decodeAndVerify(route.feedId, updateData);

    if (publishTime == 0) {
      revert InvalidPublishTime();
    }

    uint256 maxPublishTime = block.timestamp +
      providerMaxFutureSeconds[route.providerId];
    if (publishTime > maxPublishTime) {
      revert PriceTimestampTooFarInFuture(publishTime, maxPublishTime);
    }

    currencyDecimals = route.currencyDecimals;
    expiration = publishTime + route.maxAgeSeconds;

    // Fail early on a stale price rather than returning one past its freshness
    // window, so no consumer can act on it. The adapter already rejects reports
    // past the provider's own expiry; this enforces the tighter per-route
    // `maxAgeSeconds` window.
    if (block.timestamp > expiration) {
      revert PriceExpired(expiration, block.timestamp);
    }

    uint256 cachedPublishTime = cachedPublishTimes[
      route.providerId
    ][route.feedId];
    if (publishTime < cachedPublishTime) {
      revert PriceTimestampRollback(
        route.providerId,
        route.feedId,
        publishTime,
        cachedPublishTime
      );
    }
    if (publishTime > cachedPublishTime) {
      cachedPublishTimes[route.providerId][route.feedId] = publishTime;
    }
  }

  /// @notice Returns the configured USD (mid) price for a currency.
  /// @param currency Currency whose USD price should be returned.
  /// @return price USD price data for `currency`.
  function _resolveUsdPrice(
    Currency calldata currency
  ) internal returns (Price memory price) {
    price = _resolveUsdPrice(currencyToTokenId(currency));
  }

  /// @notice Returns the configured USD (mid) price for a Hub token id.
  /// @param tokenId Hub token id whose USD price should be returned.
  /// @return price USD price data for `tokenId`.
  function _resolveUsdPrice(
    uint256 tokenId
  ) internal returns (Price memory price) {
    (
      uint256 usdPrice,
      ,
      ,
      uint8 usdPriceDecimals,
      uint8 currencyDecimals,
      uint256 publishTime,
      uint256 expiration
    ) = _resolveFeed(tokenId);

    price = Price({
      usdPrice: usdPrice,
      usdPriceDecimals: usdPriceDecimals,
      currencyDecimals: currencyDecimals,
      publishTime: publishTime,
      expiration: expiration
    });
  }

  /// @notice Returns the configured mid + bid/ask band for a currency.
  /// @param currency Currency whose bid/ask band should be returned.
  /// @return bidAsk Mid + bid/ask data for `currency`.
  function _resolveBidAskPrice(
    Currency calldata currency
  ) internal returns (BidAsk memory bidAsk) {
    bidAsk = _resolveBidAskPrice(currencyToTokenId(currency));
  }

  /// @notice Returns the configured mid + bid/ask band for a Hub token id.
  /// @param tokenId Hub token id whose bid/ask band should be returned.
  /// @return bidAsk Mid + bid/ask data for `tokenId`.
  function _resolveBidAskPrice(
    uint256 tokenId
  ) internal returns (BidAsk memory bidAsk) {
    (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint8 currencyDecimals,
      uint256 publishTime,
      uint256 expiration
    ) = _resolveFeed(tokenId);

    bidAsk = BidAsk({
      midPrice: usdPrice,
      bidPrice: bid,
      askPrice: ask,
      usdPriceDecimals: usdPriceDecimals,
      currencyDecimals: currencyDecimals,
      publishTime: publishTime,
      expiration: expiration
    });
  }

  /// @notice Derives the Hub token id used as the route key for a currency.
  /// @param currency Currency to key.
  /// @return tokenId Hub token id used by `feedRoutes`.
  function currencyToTokenId(
    Currency calldata currency
  ) public pure returns (uint256 tokenId) {
    tokenId = Utils.generateTokenId(currency.chainId, currency.currency);
  }
}
