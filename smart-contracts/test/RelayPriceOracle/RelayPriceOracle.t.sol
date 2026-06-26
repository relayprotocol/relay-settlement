// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RelayPriceOracle} from "../../contracts/RelayPriceOracle.sol";
import {MockPriceFeedAdapter} from "../../contracts/mocks/MockPriceFeedAdapter.sol";
import {PriceOraclePrecompile} from "../../contracts/precompiles/PriceOraclePrecompile.sol";
import {
  Currency,
  Price
} from "../../contracts/deposit-addresses/open/oracle/IPricingOracle.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Tests the owner-managed currency to provider feed routing contract.
contract RelayPriceOracleTest is BaseTest {
  RelayPriceOracle internal config;
  MockPriceFeedAdapter internal adapter;

  bytes32 internal constant PROVIDER_CHAINLINK = keccak256("chainlink");
  bytes32 internal constant PROVIDER_PYTH = keccak256("pyth");
  bytes32 internal constant PROVIDER_REDSTONE = keccak256("redstone");
  bytes32 internal constant PYTH_ETH_FEED = keccak256("pyth-eth-usd");
  bytes32 internal constant CHAINLINK_ETH_FEED = keccak256("chainlink-eth-usd");
  bytes32 internal constant REDSTONE_BTC_FEED = keccak256("redstone-btc-usd");
  uint8 internal constant USD_PRICE_DECIMALS = 8;
  uint8 internal constant ETH_DECIMALS = 18;
  uint8 internal constant BTC_DECIMALS = 8;
  uint32 internal constant MAX_AGE_SECONDS = 60;
  uint256 internal constant NOW = 1_700_000_000;
  uint256 internal constant ETH_PUBLISH_TIME = NOW - 10;
  uint256 internal constant BTC_PUBLISH_TIME = NOW - 20;

  function setUp() public override {
    super.setUp();
    vm.warp(NOW);
    adapter = new MockPriceFeedAdapter();
    config = new RelayPriceOracle(owner);
  }

  function test_deploysWithOwner() public view {
    assertEq(config.owner(), owner);
  }

  function test_allowsOwnerToSetFeedRoute() public {
    Currency memory eth = _eth();

    vm.prank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );

    (
      bytes32 providerId,
      bytes32 feedId,
      uint8 currencyDecimals,
      uint32 maxAgeSeconds,
      bool exists
    ) = config.feedRoutes(config.currencyKey(eth));
    assertEq(providerId, PROVIDER_PYTH);
    assertEq(feedId, PYTH_ETH_FEED);
    assertEq(currencyDecimals, ETH_DECIMALS);
    assertEq(maxAgeSeconds, MAX_AGE_SECONDS);
    assertTrue(exists);
  }

  function test_emitsFeedRouteSetEvent() public {
    Currency memory eth = _eth();
    bytes32 key = config.currencyKey(eth);

    vm.expectEmit(true, true, true, true, address(config));
    emit RelayPriceOracle.FeedRouteSet(
      key,
      eth.chainId,
      eth.currency,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );

    vm.prank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
  }

  function test_allowsOwnerToReplaceFeedRoute() public {
    Currency memory eth = _eth();

    vm.startPrank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_CHAINLINK,
      CHAINLINK_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS + 1
    );
    vm.stopPrank();

    (
      bytes32 providerId,
      bytes32 feedId,
      ,
      uint32 maxAgeSeconds,
      bool exists
    ) = config.feedRoutes(config.currencyKey(eth));
    assertEq(providerId, PROVIDER_CHAINLINK);
    assertEq(feedId, CHAINLINK_ETH_FEED);
    assertEq(maxAgeSeconds, MAX_AGE_SECONDS + 1);
    assertTrue(exists);
  }

  function test_rejectsNonOwnerSetFeedRoute() public {
    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        Ownable.OwnableUnauthorizedAccount.selector,
        otherAccounts[0]
      )
    );
    config.setFeedRoute(
      _eth(),
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
  }

  function test_rejectsZeroProviderId() public {
    vm.prank(owner);
    vm.expectRevert(RelayPriceOracle.InvalidProviderId.selector);
    config.setFeedRoute(
      _eth(),
      bytes32(0),
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
  }

  function test_rejectsZeroFeedId() public {
    vm.prank(owner);
    vm.expectRevert(RelayPriceOracle.InvalidFeedId.selector);
    config.setFeedRoute(
      _eth(),
      PROVIDER_PYTH,
      bytes32(0),
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
  }

  function test_allowsOwnerToSetFeedRoutesInBatch() public {
    _setBatchRoutes();

    _assertRoute(
      _eth(),
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    _assertRoute(
      _btc(),
      PROVIDER_REDSTONE,
      REDSTONE_BTC_FEED,
      BTC_DECIMALS,
      MAX_AGE_SECONDS + 1
    );
  }

  function test_rejectsBatchArrayLengthMismatch() public {
    Currency[] memory currencies = new Currency[](1);
    bytes32[] memory providerIds = new bytes32[](2);
    bytes32[] memory feedIds = new bytes32[](1);
    uint8[] memory currencyDecimals = new uint8[](1);
    uint32[] memory maxAgeSeconds = new uint32[](1);

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.ArrayLengthMismatch.selector,
        uint256(1),
        uint256(2),
        uint256(1),
        uint256(1),
        uint256(1)
      )
    );
    config.setFeedRoutes(
      currencies,
      providerIds,
      feedIds,
      currencyDecimals,
      maxAgeSeconds
    );
  }

  function test_allowsOwnerToDeleteFeedRoute() public {
    Currency memory eth = _eth();
    bytes32 key = config.currencyKey(eth);

    vm.startPrank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );

    vm.expectEmit(true, false, false, true, address(config));
    emit RelayPriceOracle.FeedRouteDeleted(key, eth.chainId, eth.currency);
    config.deleteFeedRoute(eth);
    vm.stopPrank();

    (bytes32 providerId, bytes32 feedId, , , bool exists) = config.feedRoutes(
      key
    );
    assertEq(providerId, bytes32(0));
    assertEq(feedId, bytes32(0));
    assertFalse(exists);
  }

  function test_rejectsDeletingMissingFeedRoute() public {
    Currency memory eth = _eth();
    bytes32 key = config.currencyKey(eth);

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(RelayPriceOracle.FeedRouteNotFound.selector, key)
    );
    config.deleteFeedRoute(eth);
  }

  function test_allowsOwnerToSetPriceFeedAdapter() public {
    vm.prank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));

    assertEq(config.priceFeedAdapters(PROVIDER_PYTH), address(adapter));
  }

  function test_emitsPriceFeedAdapterSetEvent() public {
    vm.expectEmit(true, true, false, true, address(config));
    emit RelayPriceOracle.PriceFeedAdapterSet(PROVIDER_PYTH, address(adapter));

    vm.prank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));
  }

  function test_rejectsNonOwnerSetPriceFeedAdapter() public {
    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        Ownable.OwnableUnauthorizedAccount.selector,
        otherAccounts[0]
      )
    );
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));
  }

  function test_rejectsZeroProviderIdForPriceFeedAdapter() public {
    vm.prank(owner);
    vm.expectRevert(RelayPriceOracle.InvalidProviderId.selector);
    config.setPriceFeedAdapter(bytes32(0), address(adapter));
  }

  function test_rejectsZeroPriceFeedAdapter() public {
    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidPriceFeedAdapter.selector,
        address(0)
      )
    );
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(0));
  }

  function test_getUsdPricesDelegatesToConfiguredProviderFeeds() public {
    Currency[] memory currencies = new Currency[](2);
    currencies[0] = _eth();
    currencies[1] = _btc();

    uint256 pythPrice = 3500e8;
    uint256 redstonePrice = 65000e8;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(
        PYTH_ETH_FEED,
        pythPrice,
        USD_PRICE_DECIMALS,
        ETH_PUBLISH_TIME
      )
    );
    _mockFeed(
      PROVIDER_REDSTONE,
      REDSTONE_BTC_FEED,
      _encodeUpdate(
        REDSTONE_BTC_FEED,
        redstonePrice,
        USD_PRICE_DECIMALS,
        BTC_PUBLISH_TIME
      )
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));
    config.setPriceFeedAdapter(PROVIDER_REDSTONE, address(adapter));
    config.setFeedRoute(
      currencies[0],
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    config.setFeedRoute(
      currencies[1],
      PROVIDER_REDSTONE,
      REDSTONE_BTC_FEED,
      BTC_DECIMALS,
      MAX_AGE_SECONDS + 1
    );
    vm.stopPrank();

    Price[] memory prices = config.getUsdPrices(currencies);

    assertEq(prices[0].usdPrice, pythPrice);
    assertEq(prices[0].usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(prices[0].currencyDecimals, ETH_DECIMALS);
    assertEq(prices[0].expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
    assertEq(prices[1].usdPrice, redstonePrice);
    assertEq(prices[1].usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(prices[1].currencyDecimals, BTC_DECIMALS);
    assertEq(prices[1].expiration, BTC_PUBLISH_TIME + MAX_AGE_SECONDS + 1);
  }

  function test_getUsdPriceDelegatesToConfiguredProviderFeed() public {
    Currency memory eth = _eth();
    uint256 pythPrice = 3500e8;
    uint256 chainlinkPrice = 3600e8;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(
        PYTH_ETH_FEED,
        pythPrice,
        USD_PRICE_DECIMALS,
        ETH_PUBLISH_TIME
      )
    );
    _mockFeed(
      PROVIDER_CHAINLINK,
      PYTH_ETH_FEED,
      _encodeUpdate(
        PYTH_ETH_FEED,
        chainlinkPrice,
        USD_PRICE_DECIMALS,
        ETH_PUBLISH_TIME + 1
      )
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    Price memory price = config.getUsdPrice(eth);
    assertEq(price.usdPrice, pythPrice);
    assertEq(price.usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(price.currencyDecimals, ETH_DECIMALS);
    assertEq(price.expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
  }

  function test_getUsdPriceRevertsForMissingPriceFeedAdapter() public {
    Currency memory eth = _eth();

    vm.prank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceFeedAdapterNotFound.selector,
        PROVIDER_PYTH
      )
    );
    config.getUsdPrice(eth);
  }

  function test_getUsdPriceRevertsWhenAdapterRejectsFeed() public {
    Currency memory eth = _eth();
    bytes32 wrongFeed = keccak256("wrong-feed");

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(wrongFeed, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter));
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    vm.expectRevert(
      abi.encodeWithSelector(
        MockPriceFeedAdapter.FeedIdMismatch.selector,
        PYTH_ETH_FEED,
        wrongFeed
      )
    );
    config.getUsdPrice(eth);
  }

  function test_getUsdPricesRevertsForMissingRoute() public {
    Currency[] memory currencies = new Currency[](1);
    currencies[0] = _eth();
    bytes32 key = config.currencyKey(currencies[0]);

    vm.expectRevert(
      abi.encodeWithSelector(RelayPriceOracle.FeedRouteNotFound.selector, key)
    );
    config.getUsdPrices(currencies);
  }

  function test_getUsdPricesRejectsOversizedBatch() public {
    uint256 maxBatchSize = config.MAX_PRICE_BATCH_SIZE();
    Currency[] memory currencies = new Currency[](maxBatchSize + 1);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceBatchTooLarge.selector,
        maxBatchSize + 1,
        maxBatchSize
      )
    );
    config.getUsdPrices(currencies);
  }

  function _eth() internal pure returns (Currency memory currency) {
    currency = Currency({
      chainId: "ethereum",
      currency: abi.encodePacked(address(0))
    });
  }

  function _btc() internal pure returns (Currency memory currency) {
    currency = Currency({chainId: "bitcoin", currency: bytes("BTC")});
  }

  function _setBatchRoutes() internal {
    Currency[] memory currencies = new Currency[](2);
    currencies[0] = _eth();
    currencies[1] = _btc();

    bytes32[] memory providerIds = new bytes32[](2);
    providerIds[0] = PROVIDER_PYTH;
    providerIds[1] = PROVIDER_REDSTONE;

    bytes32[] memory feedIds = new bytes32[](2);
    feedIds[0] = PYTH_ETH_FEED;
    feedIds[1] = REDSTONE_BTC_FEED;

    uint8[] memory currencyDecimals = new uint8[](2);
    currencyDecimals[0] = ETH_DECIMALS;
    currencyDecimals[1] = BTC_DECIMALS;

    uint32[] memory maxAgeSeconds = new uint32[](2);
    maxAgeSeconds[0] = MAX_AGE_SECONDS;
    maxAgeSeconds[1] = MAX_AGE_SECONDS + 1;

    vm.prank(owner);
    config.setFeedRoutes(
      currencies,
      providerIds,
      feedIds,
      currencyDecimals,
      maxAgeSeconds
    );
  }

  function _encodeUpdate(
    bytes32 feedId,
    uint256 usdPrice,
    uint8 usdPriceDecimals,
    uint256 publishTime
  ) internal pure returns (bytes memory) {
    return abi.encode(feedId, usdPrice, usdPriceDecimals, publishTime);
  }

  function _mockFeed(
    bytes32 providerId,
    bytes32 feedId,
    bytes memory updateData
  ) internal {
    vm.mockCall(
      PriceOraclePrecompile.PRECOMPILE,
      abi.encodePacked(providerId, feedId),
      updateData
    );
  }

  function _assertRoute(
    Currency memory currency,
    bytes32 expectedProviderId,
    bytes32 expectedFeedId,
    uint8 expectedCurrencyDecimals,
    uint32 expectedMaxAgeSeconds
  ) internal view {
    (
      bytes32 providerId,
      bytes32 feedId,
      uint8 currencyDecimals,
      uint32 maxAgeSeconds,
      bool exists
    ) = config.feedRoutes(config.currencyKey(currency));
    assertEq(providerId, expectedProviderId);
    assertEq(feedId, expectedFeedId);
    assertEq(currencyDecimals, expectedCurrencyDecimals);
    assertEq(maxAgeSeconds, expectedMaxAgeSeconds);
    assertTrue(exists);
  }
}
