// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";
import {RelayPriceOracle} from "../../contracts/RelayPriceOracle.sol";
import {MockPriceFeedAdapter} from "../../contracts/mocks/MockPriceFeedAdapter.sol";
import {PriceOraclePrecompile} from "../../contracts/precompiles/PriceOraclePrecompile.sol";
import {
  BidAsk,
  Currency,
  Price
} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";
import {Utils} from "../../contracts/Utils.sol";
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
  uint32 internal constant MAX_AGE_SECONDS_UPPER_BOUND = 300;
  uint32 internal constant MAX_FUTURE_SECONDS = 12;
  uint32 internal constant MAX_FUTURE_SECONDS_UPPER_BOUND = 60;
  uint256 internal constant NOW = 1_700_000_000;
  uint256 internal constant ETH_PUBLISH_TIME = NOW - 10;
  uint256 internal constant BTC_PUBLISH_TIME = NOW - 20;

  function setUp() public override {
    super.setUp();
    vm.warp(NOW);
    config = new RelayPriceOracle(owner);
    adapter = new MockPriceFeedAdapter(address(config));
  }

  function test_deploysWithOwner() public view {
    assertEq(config.owner(), owner);
    assertEq(
      config.MAX_FUTURE_SECONDS_UPPER_BOUND(),
      MAX_FUTURE_SECONDS_UPPER_BOUND
    );
    assertEq(config.MAX_AGE_SECONDS_UPPER_BOUND(), MAX_AGE_SECONDS_UPPER_BOUND);
  }

  function test_allowsOwnerToSetFeedRoute() public {
    Currency memory eth = _eth();
    uint256 tokenId = config.currencyToTokenId(eth);

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
    ) = config.feedRoutes(tokenId);
    assertEq(providerId, PROVIDER_PYTH);
    assertEq(feedId, PYTH_ETH_FEED);
    assertEq(currencyDecimals, ETH_DECIMALS);
    assertEq(maxAgeSeconds, MAX_AGE_SECONDS);
    assertTrue(exists);
  }

  function test_emitsFeedRouteSetEvent() public {
    Currency memory eth = _eth();
    uint256 tokenId = config.currencyToTokenId(eth);

    vm.expectEmit(true, true, true, true, address(config));
    emit RelayPriceOracle.FeedRouteSet(
      tokenId,
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
    uint256 tokenId = config.currencyToTokenId(eth);

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
    ) = config.feedRoutes(tokenId);
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

  function test_allowsMaxAgeSecondsAtUpperBound() public {
    vm.prank(owner);
    config.setFeedRoute(
      _eth(),
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS_UPPER_BOUND
    );

    (, , , uint32 maxAgeSeconds, ) = config.feedRoutes(
      config.currencyToTokenId(_eth())
    );
    assertEq(maxAgeSeconds, MAX_AGE_SECONDS_UPPER_BOUND);
  }

  function test_allowsZeroMaxAgeSeconds() public {
    vm.prank(owner);
    config.setFeedRoute(_eth(), PROVIDER_PYTH, PYTH_ETH_FEED, ETH_DECIMALS, 0);

    (, , , uint32 maxAgeSeconds, ) = config.feedRoutes(
      config.currencyToTokenId(_eth())
    );
    assertEq(maxAgeSeconds, 0);
  }

  function test_rejectsMaxAgeSecondsAboveUpperBound() public {
    uint32 invalidMaxAgeSeconds = MAX_AGE_SECONDS_UPPER_BOUND + 1;

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidMaxAgeSeconds.selector,
        invalidMaxAgeSeconds,
        MAX_AGE_SECONDS_UPPER_BOUND
      )
    );
    config.setFeedRoute(
      _eth(),
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      invalidMaxAgeSeconds
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
    uint256 tokenId = config.currencyToTokenId(eth);

    vm.startPrank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );

    vm.expectEmit(true, false, false, true, address(config));
    emit RelayPriceOracle.FeedRouteDeleted(tokenId, eth.chainId, eth.currency);
    config.deleteFeedRoute(eth);
    vm.stopPrank();

    (bytes32 providerId, bytes32 feedId, , , bool exists) = config.feedRoutes(
      tokenId
    );
    assertEq(providerId, bytes32(0));
    assertEq(feedId, bytes32(0));
    assertFalse(exists);
  }

  function test_rejectsDeletingMissingFeedRoute() public {
    Currency memory eth = _eth();
    uint256 tokenId = config.currencyToTokenId(eth);

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.FeedRouteNotFound.selector,
        tokenId
      )
    );
    config.deleteFeedRoute(eth);
  }

  function test_allowsOwnerToSetPriceFeedAdapter() public {
    vm.prank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );

    assertEq(config.priceFeedAdapters(PROVIDER_PYTH), address(adapter));
    assertEq(
      config.providerMaxFutureSeconds(PROVIDER_PYTH),
      MAX_FUTURE_SECONDS
    );
  }

  function test_emitsPriceFeedAdapterSetEvent() public {
    vm.expectEmit(true, true, false, true, address(config));
    emit RelayPriceOracle.PriceFeedAdapterSet(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );

    vm.prank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
  }

  function test_allowsOwnerToSetExplicitMaxFutureSeconds() public {
    vm.prank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS_UPPER_BOUND
    );

    assertEq(config.priceFeedAdapters(PROVIDER_PYTH), address(adapter));
    assertEq(
      config.providerMaxFutureSeconds(PROVIDER_PYTH),
      MAX_FUTURE_SECONDS_UPPER_BOUND
    );
  }

  function test_allowsZeroMaxFutureSeconds() public {
    vm.prank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter), 0);

    assertEq(config.providerMaxFutureSeconds(PROVIDER_PYTH), 0);
  }

  function test_adapterReplacementUpdatesMaxFutureSeconds() public {
    MockPriceFeedAdapter replacement = new MockPriceFeedAdapter(
      address(config)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter), 0);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(replacement),
      MAX_FUTURE_SECONDS
    );
    vm.stopPrank();

    assertEq(config.priceFeedAdapters(PROVIDER_PYTH), address(replacement));
    assertEq(
      config.providerMaxFutureSeconds(PROVIDER_PYTH),
      MAX_FUTURE_SECONDS
    );
  }

  function test_rejectsMaxFutureSecondsAboveHardCap() public {
    uint32 invalidMaxFutureSeconds = MAX_FUTURE_SECONDS_UPPER_BOUND + 1;

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidMaxFutureSeconds.selector,
        invalidMaxFutureSeconds,
        MAX_FUTURE_SECONDS_UPPER_BOUND
      )
    );
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      invalidMaxFutureSeconds
    );
  }

  function test_rejectsNonOwnerSetPriceFeedAdapter() public {
    vm.prank(otherAccounts[0]);
    vm.expectRevert(
      abi.encodeWithSelector(
        Ownable.OwnableUnauthorizedAccount.selector,
        otherAccounts[0]
      )
    );
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
  }

  function test_rejectsZeroProviderIdForPriceFeedAdapter() public {
    vm.prank(owner);
    vm.expectRevert(RelayPriceOracle.InvalidProviderId.selector);
    config.setPriceFeedAdapter(
      bytes32(0),
      address(adapter),
      MAX_FUTURE_SECONDS
    );
  }

  function test_rejectsZeroPriceFeedAdapter() public {
    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidPriceFeedAdapter.selector,
        address(0)
      )
    );
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(0), MAX_FUTURE_SECONDS);
  }

  function test_rejectsAdapterBoundToAnotherOracle() public {
    MockPriceFeedAdapter wrongAdapter = new MockPriceFeedAdapter(
      otherAccounts[0]
    );

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidPriceFeedAdapterOracle.selector,
        address(wrongAdapter),
        address(config),
        otherAccounts[0]
      )
    );
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(wrongAdapter),
      MAX_FUTURE_SECONDS
    );
  }

  function test_rejectsAddressWithoutAdapterInterface() public {
    address invalidAdapter = otherAccounts[0];

    vm.prank(owner);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.InvalidPriceFeedAdapter.selector,
        invalidAdapter
      )
    );
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      invalidAdapter,
      MAX_FUTURE_SECONDS
    );
  }

  function test_resolveUsdPricesDelegatesToConfiguredProviderFeeds() public {
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
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setPriceFeedAdapter(
      PROVIDER_REDSTONE,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
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

    Price[] memory prices = config.resolveUsdPrices(currencies);

    assertEq(prices[0].usdPrice, pythPrice);
    assertEq(prices[0].usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(prices[0].currencyDecimals, ETH_DECIMALS);
    assertEq(prices[0].publishTime, ETH_PUBLISH_TIME);
    assertEq(prices[0].expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
    assertEq(prices[1].usdPrice, redstonePrice);
    assertEq(prices[1].usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(prices[1].currencyDecimals, BTC_DECIMALS);
    assertEq(prices[1].publishTime, BTC_PUBLISH_TIME);
    assertEq(prices[1].expiration, BTC_PUBLISH_TIME + MAX_AGE_SECONDS + 1);
  }

  function test_resolveUsdPriceDelegatesToConfiguredProviderFeed() public {
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
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    Price memory price = config.resolveUsdPrice(eth);
    assertEq(price.usdPrice, pythPrice);
    assertEq(price.usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(price.currencyDecimals, ETH_DECIMALS);
    assertEq(price.publishTime, ETH_PUBLISH_TIME);
    assertEq(price.expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
  }

  function test_currencyKeyUsesUtilsGenerateTokenId() public view {
    Currency memory eth = _eth();
    assertEq(
      config.currencyToTokenId(eth),
      Utils.generateTokenId(eth.chainId, eth.currency)
    );
  }

  function test_resolveUsdPriceByTokenId() public {
    Currency memory eth = _eth();
    uint256 tokenId = config.currencyToTokenId(eth);
    uint256 pythPrice = 3500e8;

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

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    Price memory price = config.resolveUsdPrice(tokenId);

    assertEq(price.usdPrice, pythPrice);
    assertEq(price.usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(price.currencyDecimals, ETH_DECIMALS);
    assertEq(price.publishTime, ETH_PUBLISH_TIME);
    assertEq(price.expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
  }

  function test_resolveUsdPricesByErc20Views() public {
    Currency[] memory currencies = new Currency[](2);
    currencies[0] = _eth();
    currencies[1] = _btc();

    address[] memory erc20Views = new address[](2);
    erc20Views[0] = address(
      new ERC20View(config.currencyToTokenId(currencies[0]))
    );
    erc20Views[1] = address(
      new ERC20View(config.currencyToTokenId(currencies[1]))
    );

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
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setPriceFeedAdapter(
      PROVIDER_REDSTONE,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
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

    Price[] memory prices = config.resolveUsdPrices(erc20Views);

    assertEq(prices[0].usdPrice, pythPrice);
    assertEq(prices[0].currencyDecimals, ETH_DECIMALS);
    assertEq(prices[1].usdPrice, redstonePrice);
    assertEq(prices[1].currencyDecimals, BTC_DECIMALS);
  }

  function test_resolveBidAskPriceByTokenId() public {
    Currency memory eth = _eth();
    uint256 tokenId = config.currencyToTokenId(eth);
    uint256 pythPrice = 3500e8;

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

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    BidAsk memory bidAsk = config.resolveBidAskPrice(tokenId);

    assertEq(bidAsk.midPrice, pythPrice);
    assertEq(bidAsk.bidPrice, 0);
    assertEq(bidAsk.askPrice, 0);
    assertEq(bidAsk.usdPriceDecimals, USD_PRICE_DECIMALS);
    assertEq(bidAsk.currencyDecimals, ETH_DECIMALS);
    assertEq(bidAsk.publishTime, ETH_PUBLISH_TIME);
    assertEq(bidAsk.expiration, ETH_PUBLISH_TIME + MAX_AGE_SECONDS);
  }

  function test_resolveUsdPriceRevertsForMissingPriceFeedAdapter() public {
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
    config.resolveUsdPrice(eth);
  }

  function test_resolveUsdPriceRevertsWhenAdapterRejectsFeed() public {
    Currency memory eth = _eth();
    bytes32 wrongFeed = keccak256("wrong-feed");

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(wrongFeed, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
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
    config.resolveUsdPrice(eth);
  }

  function test_resolveUsdPriceRevertsWhenPriceExpired() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    uint256 expiration = ETH_PUBLISH_TIME + MAX_AGE_SECONDS;
    vm.warp(expiration + 1);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceExpired.selector,
        expiration,
        expiration + 1
      )
    );
    config.resolveUsdPrice(eth);
  }

  function test_rejectsZeroPublishTime() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, 0)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    vm.expectRevert(RelayPriceOracle.InvalidPublishTime.selector);
    config.resolveUsdPrice(eth);
  }

  function test_recordsCachedPublishTime() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    config.resolveUsdPrice(eth);

    assertEq(
      config.cachedPublishTimes(PROVIDER_PYTH, PYTH_ETH_FEED),
      ETH_PUBLISH_TIME
    );
  }

  function test_tracksPublishTimesPerProviderAndFeed() public {
    Currency memory eth = _eth();
    uint256 firstPublishTime = NOW - 1;
    uint256 secondPublishTime = NOW - 2;
    uint256 thirdPublishTime = NOW - 3;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, firstPublishTime)
    );
    _mockFeed(
      PROVIDER_PYTH,
      REDSTONE_BTC_FEED,
      _encodeUpdate(
        REDSTONE_BTC_FEED,
        3500e8,
        USD_PRICE_DECIMALS,
        secondPublishTime
      )
    );
    _mockFeed(
      PROVIDER_REDSTONE,
      REDSTONE_BTC_FEED,
      _encodeUpdate(
        REDSTONE_BTC_FEED,
        3500e8,
        USD_PRICE_DECIMALS,
        thirdPublishTime
      )
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setPriceFeedAdapter(
      PROVIDER_REDSTONE,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    config.resolveUsdPrice(eth);

    vm.prank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      REDSTONE_BTC_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    config.resolveUsdPrice(eth);

    vm.prank(owner);
    config.setFeedRoute(
      eth,
      PROVIDER_REDSTONE,
      REDSTONE_BTC_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    config.resolveUsdPrice(eth);

    assertEq(
      config.cachedPublishTimes(PROVIDER_PYTH, PYTH_ETH_FEED),
      firstPublishTime
    );
    assertEq(
      config.cachedPublishTimes(PROVIDER_PYTH, REDSTONE_BTC_FEED),
      secondPublishTime
    );
    assertEq(
      config.cachedPublishTimes(PROVIDER_REDSTONE, REDSTONE_BTC_FEED),
      thirdPublishTime
    );
  }

  function test_allowsEqualPublishTime() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    config.resolveUsdPrice(eth);

    uint256 replacementPrice = 3501e8;
    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(
        PYTH_ETH_FEED,
        replacementPrice,
        USD_PRICE_DECIMALS,
        ETH_PUBLISH_TIME
      )
    );

    Price memory price = config.resolveUsdPrice(eth);
    assertEq(price.usdPrice, replacementPrice);
    assertEq(
      config.cachedPublishTimes(PROVIDER_PYTH, PYTH_ETH_FEED),
      ETH_PUBLISH_TIME
    );
  }

  function test_rejectsPublishTimeRollback() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    config.resolveUsdPrice(eth);

    uint256 olderPublishTime = ETH_PUBLISH_TIME - 1;
    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3499e8, USD_PRICE_DECIMALS, olderPublishTime)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceTimestampRollback.selector,
        PROVIDER_PYTH,
        PYTH_ETH_FEED,
        olderPublishTime,
        ETH_PUBLISH_TIME
      )
    );
    config.resolveUsdPrice(eth);
  }

  function test_preservesPublishTimeAcrossAdapterReplacement() public {
    Currency memory eth = _eth();

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, ETH_PUBLISH_TIME)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    config.resolveUsdPrice(eth);

    MockPriceFeedAdapter replacement = new MockPriceFeedAdapter(
      address(config)
    );
    vm.prank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(replacement),
      MAX_FUTURE_SECONDS
    );

    uint256 olderPublishTime = ETH_PUBLISH_TIME - 1;
    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3499e8, USD_PRICE_DECIMALS, olderPublishTime)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceTimestampRollback.selector,
        PROVIDER_PYTH,
        PYTH_ETH_FEED,
        olderPublishTime,
        ETH_PUBLISH_TIME
      )
    );
    config.resolveUsdPrice(eth);
  }

  function test_resolveUsdPriceAllowsPublishTimeAtFutureLimit() public {
    Currency memory eth = _eth();
    uint256 publishTime = NOW + MAX_FUTURE_SECONDS;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, publishTime)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    config.setFeedRoute(
      eth,
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      ETH_DECIMALS,
      MAX_AGE_SECONDS
    );
    vm.stopPrank();

    Price memory price = config.resolveUsdPrice(eth);
    assertEq(price.expiration, publishTime + MAX_AGE_SECONDS);
  }

  function test_resolveUsdPriceRejectsPublishTimeAboveFutureLimit() public {
    Currency memory eth = _eth();
    uint256 maxPublishTime = NOW + MAX_FUTURE_SECONDS;
    uint256 publishTime = maxPublishTime + 1;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, publishTime)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(
      PROVIDER_PYTH,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
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
        RelayPriceOracle.PriceTimestampTooFarInFuture.selector,
        publishTime,
        maxPublishTime
      )
    );
    config.resolveUsdPrice(eth);
  }

  function test_resolveUsdPriceRejectsAnyFutureTimeInStrictMode() public {
    Currency memory eth = _eth();
    uint256 publishTime = NOW + 1;

    _mockFeed(
      PROVIDER_PYTH,
      PYTH_ETH_FEED,
      _encodeUpdate(PYTH_ETH_FEED, 3500e8, USD_PRICE_DECIMALS, publishTime)
    );

    vm.startPrank(owner);
    config.setPriceFeedAdapter(PROVIDER_PYTH, address(adapter), 0);
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
        RelayPriceOracle.PriceTimestampTooFarInFuture.selector,
        publishTime,
        NOW
      )
    );
    config.resolveUsdPrice(eth);
  }

  function test_resolveUsdPricesRevertsForMissingRoute() public {
    Currency[] memory currencies = new Currency[](1);
    currencies[0] = _eth();
    uint256 tokenId = config.currencyToTokenId(currencies[0]);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.FeedRouteNotFound.selector,
        tokenId
      )
    );
    config.resolveUsdPrices(currencies);
  }

  function test_resolveUsdPricesRejectsOversizedBatch() public {
    uint256 maxBatchSize = config.MAX_PRICE_BATCH_SIZE();
    Currency[] memory currencies = new Currency[](maxBatchSize + 1);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayPriceOracle.PriceBatchTooLarge.selector,
        maxBatchSize + 1,
        maxBatchSize
      )
    );
    config.resolveUsdPrices(currencies);
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
    ) = config.feedRoutes(config.currencyToTokenId(currency));
    assertEq(providerId, expectedProviderId);
    assertEq(feedId, expectedFeedId);
    assertEq(currencyDecimals, expectedCurrencyDecimals);
    assertEq(maxAgeSeconds, expectedMaxAgeSeconds);
    assertTrue(exists);
  }
}
