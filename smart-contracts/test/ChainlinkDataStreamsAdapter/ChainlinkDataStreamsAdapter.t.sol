// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  ChainlinkDataStreamsAdapter,
  IVerifierProxy
} from "../../contracts/price-adapters/ChainlinkDataStreamsAdapter.sol";
import {MockVerifierProxy} from "../../contracts/mocks/MockVerifierProxy.sol";
import {
  IPriceFeedAdapter,
  RelayPriceOracle
} from "../../contracts/RelayPriceOracle.sol";
import {PriceOraclePrecompile} from "../../contracts/precompiles/PriceOraclePrecompile.sol";
import {
  BidAsk,
  Currency,
  Price
} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Tests the Chainlink Data Streams V3 price feed adapter, both in
///         isolation and wired into `RelayPriceOracle` via the mock precompile.
contract ChainlinkDataStreamsAdapterTest is BaseTest {
  ChainlinkDataStreamsAdapter internal adapter;
  MockVerifierProxy internal verifierProxy;
  RelayPriceOracle internal oracle;

  bytes32 internal constant PROVIDER_CHAINLINK = keccak256("chainlink");
  uint32 internal constant MAX_FUTURE_SECONDS = 12;
  uint256 internal constant NOW = 1_700_000_000;
  uint32 internal constant OBSERVATIONS_TIME = uint32(NOW - 10);
  uint32 internal constant EXPIRES_AT = uint32(NOW + 3600);
  int192 internal constant ETH_PRICE = 3_750e18;

  function setUp() public override {
    super.setUp();
    vm.warp(NOW);
    verifierProxy = new MockVerifierProxy();
    oracle = new RelayPriceOracle(owner);
    adapter = new ChainlinkDataStreamsAdapter(
      address(oracle),
      verifierProxy,
      address(0)
    );
  }

  function test_decodesV3Report() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    ) = _decodeAndVerify(feedId, report);

    assertEq(usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bid, uint256(uint192(ETH_PRICE)));
    assertEq(ask, uint256(uint192(ETH_PRICE)));
    assertEq(usdPriceDecimals, 18);
    assertEq(publishTime, OBSERVATIONS_TIME);
  }

  function test_bindsRelayPriceOracle() public view {
    assertEq(adapter.ORACLE(), address(oracle));
  }

  function test_rejectsZeroOracle() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        IPriceFeedAdapter.InvalidOracle.selector,
        address(0)
      )
    );
    new ChainlinkDataStreamsAdapter(address(0), verifierProxy, address(0));
  }

  function test_rejectsUnauthorizedCaller() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        IPriceFeedAdapter.UnauthorizedCaller.selector,
        address(this)
      )
    );
    adapter.decodeAndVerify(feedId, report);
  }

  function test_returnsBidAndAskBand() public {
    bytes32 feedId = _v3FeedId(0x01);
    int192 bidPrice = ETH_PRICE - 5e18;
    int192 askPrice = ETH_PRICE + 5e18;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      bidPrice,
      askPrice,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    (uint256 usdPrice, uint256 bid, uint256 ask, , ) = _decodeAndVerify(
      feedId,
      report
    );

    assertEq(usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bid, uint256(uint192(bidPrice)));
    assertEq(ask, uint256(uint192(askPrice)));
  }

  function test_reportsZeroBandWhenBidAskMissing() public {
    bytes32 feedId = _v3FeedId(0x01);
    // A feed with no bid/ask info reports them as zero; the adapter surfaces 0
    // to signal the band is unavailable rather than fabricating a band.
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      int192(0),
      int192(0),
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    (uint256 usdPrice, uint256 bid, uint256 ask, , ) = _decodeAndVerify(
      feedId,
      report
    );

    assertEq(usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bid, 0);
    assertEq(ask, 0);
  }

  function test_rejectsOneSidedBand() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      int192(0),
      ETH_PRICE + 5e18,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidBidAsk.selector,
        ETH_PRICE,
        int192(0),
        ETH_PRICE + 5e18
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_rejectsNegativeBand() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      int192(-1),
      ETH_PRICE + 5e18,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidBidAsk.selector,
        ETH_PRICE,
        int192(-1),
        ETH_PRICE + 5e18
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_rejectsBidAboveBenchmark() public {
    bytes32 feedId = _v3FeedId(0x01);
    int192 bidPrice = ETH_PRICE + 1;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      bidPrice,
      ETH_PRICE + 5e18,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidBidAsk.selector,
        ETH_PRICE,
        bidPrice,
        ETH_PRICE + 5e18
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_rejectsAskBelowBenchmark() public {
    bytes32 feedId = _v3FeedId(0x01);
    int192 askPrice = ETH_PRICE - 1;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      ETH_PRICE - 5e18,
      askPrice,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidBidAsk.selector,
        ETH_PRICE,
        ETH_PRICE - 5e18,
        askPrice
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_revertsOnFeedIdMismatch() public {
    bytes32 reportFeedId = _v3FeedId(0x01);
    bytes32 requestedFeedId = _v3FeedId(0x02);
    bytes memory report = _fullReport(
      reportFeedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.FeedIdMismatch.selector,
        requestedFeedId,
        reportFeedId
      )
    );
    _decodeAndVerify(requestedFeedId, report);
  }

  function test_revertsOnUnsupportedSchema() public {
    // V4-tagged feed ID (`0x0004` prefix); feed IDs match so the schema check
    // is what fires.
    bytes32 feedId = bytes32((uint256(0x0004) << 240) | 0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.UnsupportedReportSchema.selector,
        uint16(0x0004)
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_revertsOnZeroPrice() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(feedId, 0, OBSERVATIONS_TIME, EXPIRES_AT);

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.NonPositivePrice.selector,
        int192(0)
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_revertsOnNegativePrice() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      -1,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.NonPositivePrice.selector,
        int192(-1)
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_revertsOnExpiredReport() public {
    bytes32 feedId = _v3FeedId(0x01);
    uint32 expiresAt = uint32(NOW - 1);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      expiresAt
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.ReportExpired.selector,
        expiresAt,
        NOW
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_rejectsValidFromAfterObservation() public {
    bytes32 feedId = _v3FeedId(0x01);
    uint32 validFromTimestamp = OBSERVATIONS_TIME + 1;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      validFromTimestamp,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidReportTimeRange.selector,
        validFromTimestamp,
        OBSERVATIONS_TIME,
        EXPIRES_AT
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_rejectsObservationAfterExpiry() public {
    bytes32 feedId = _v3FeedId(0x01);
    uint32 expiresAt = OBSERVATIONS_TIME - 1;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      OBSERVATIONS_TIME,
      expiresAt
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.InvalidReportTimeRange.selector,
        OBSERVATIONS_TIME,
        OBSERVATIONS_TIME,
        expiresAt
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_allowsFutureValidFrom() public {
    bytes32 feedId = _v3FeedId(0x01);
    uint32 futureTimestamp = uint32(NOW + 5);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      futureTimestamp,
      futureTimestamp,
      EXPIRES_AT
    );

    (, , , , uint256 publishTime) = _decodeAndVerify(feedId, report);

    assertEq(publishTime, futureTimestamp);
  }

  function test_allowsExpiryBoundary() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      uint32(NOW)
    );

    (, , , , uint256 publishTime) = _decodeAndVerify(feedId, report);

    assertEq(publishTime, OBSERVATIONS_TIME);
  }

  function test_cacheHitSkipsVerifier() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes32 otherFeedId = _v3FeedId(0x02);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );
    bytes memory otherReport = _fullReport(
      otherFeedId,
      ETH_PRICE + 1e18,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, report);

    // Any further verification attempt reverts, so success below proves the
    // adapter served the decoded values from its cache.
    vm.mockCallRevert(
      address(verifierProxy),
      abi.encodeWithSelector(IVerifierProxy.verify.selector),
      "verify must not be called"
    );

    (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    ) = _decodeAndVerify(feedId, report);

    assertEq(usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bid, uint256(uint192(ETH_PRICE)));
    assertEq(ask, uint256(uint192(ETH_PRICE)));
    assertEq(usdPriceDecimals, 18);
    assertEq(publishTime, OBSERVATIONS_TIME);

    // The cache is keyed per feed, so another feed's first use must verify.
    vm.expectRevert(bytes("verify must not be called"));
    _decodeAndVerify(otherFeedId, otherReport);
  }

  function test_reverifiesWhenReportChanges() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory oldReport = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );
    int192 newPrice = ETH_PRICE + 100e18;
    bytes memory newReport = _fullReport(
      feedId,
      newPrice,
      OBSERVATIONS_TIME + 5,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, oldReport);

    vm.expectCall(
      address(verifierProxy),
      abi.encodeWithSelector(
        IVerifierProxy.verify.selector,
        newReport,
        abi.encode(address(0))
      ),
      1
    );
    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      feedId,
      newReport
    );
    assertEq(usdPrice, uint256(uint192(newPrice)));
    assertEq(publishTime, OBSERVATIONS_TIME + 5);

    // The new report overwrote the cache entry, so only the old report would re-verify.
    vm.mockCallRevert(
      address(verifierProxy),
      abi.encodeWithSelector(IVerifierProxy.verify.selector),
      "verify must not be called"
    );
    (usdPrice, , , , ) = _decodeAndVerify(feedId, newReport);
    assertEq(usdPrice, uint256(uint192(newPrice)));

    vm.expectRevert(bytes("verify must not be called"));
    _decodeAndVerify(feedId, oldReport);
  }

  function test_rejectsOlderObservation() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory latestReport = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );
    uint32 olderTimestamp = OBSERVATIONS_TIME - 1;
    bytes memory olderReport = _fullReport(
      feedId,
      ETH_PRICE - 1e18,
      olderTimestamp,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, latestReport);

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.TimestampRollback.selector,
        feedId,
        olderTimestamp,
        OBSERVATIONS_TIME
      )
    );
    _decodeAndVerify(feedId, olderReport);

    (bytes32 reportHash, , , uint32 observationsTimestamp, , , ) = adapter
      .cachedReports(feedId);
    assertEq(reportHash, keccak256(latestReport));
    assertEq(observationsTimestamp, OBSERVATIONS_TIME);
  }

  function test_allowsEqualTimestampReplacement() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory oldReport = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );
    int192 newPrice = ETH_PRICE + 1e18;
    bytes memory newReport = _fullReport(
      feedId,
      newPrice,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, oldReport);
    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      feedId,
      newReport
    );

    assertEq(usdPrice, uint256(uint192(newPrice)));
    assertEq(publishTime, OBSERVATIONS_TIME);
    (bytes32 reportHash, , , , , , ) = adapter.cachedReports(feedId);
    assertEq(reportHash, keccak256(newReport));
  }

  function test_cacheHitEnforcesExpiry() public {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, report);

    // The expiry check must fire on the cached path without re-verification.
    vm.mockCallRevert(
      address(verifierProxy),
      abi.encodeWithSelector(IVerifierProxy.verify.selector),
      "verify must not be called"
    );
    vm.warp(uint256(EXPIRES_AT) + 1);

    vm.expectRevert(
      abi.encodeWithSelector(
        ChainlinkDataStreamsAdapter.ReportExpired.selector,
        EXPIRES_AT,
        uint256(EXPIRES_AT) + 1
      )
    );
    _decodeAndVerify(feedId, report);
  }

  function test_exposesCachedReport() public {
    bytes32 feedId = _v3FeedId(0x01);
    int192 bidPrice = ETH_PRICE - 5e18;
    int192 askPrice = ETH_PRICE + 5e18;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      bidPrice,
      askPrice,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    _decodeAndVerify(feedId, report);

    (
      bytes32 reportHash,
      int192 benchmarkPrice,
      uint32 validFromTimestamp,
      uint32 observationsTimestamp,
      uint32 expiresAt,
      int192 bid,
      int192 ask
    ) = adapter.cachedReports(feedId);

    assertEq(reportHash, keccak256(report));
    assertEq(benchmarkPrice, ETH_PRICE);
    assertEq(validFromTimestamp, OBSERVATIONS_TIME);
    assertEq(observationsTimestamp, OBSERVATIONS_TIME);
    assertEq(expiresAt, EXPIRES_AT);
    assertEq(bid, bidPrice);
    assertEq(ask, askPrice);
  }

  function test_integratesWithRelayPriceOracle() public {
    bytes32 feedId = _v3FeedId(0x0e);
    uint32 maxAgeSeconds = 60;
    uint8 ethDecimals = 18;

    Currency memory eth = Currency({
      chainId: "ethereum",
      currency: abi.encodePacked(address(0))
    });

    vm.mockCall(
      PriceOraclePrecompile.PRECOMPILE,
      abi.encodePacked(PROVIDER_CHAINLINK, feedId),
      _fullReport(feedId, ETH_PRICE, OBSERVATIONS_TIME, EXPIRES_AT)
    );

    vm.startPrank(owner);
    oracle.setPriceFeedAdapter(
      PROVIDER_CHAINLINK,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    oracle.setFeedRoute(
      eth,
      PROVIDER_CHAINLINK,
      feedId,
      ethDecimals,
      maxAgeSeconds
    );
    vm.stopPrank();

    // The mid-only path returns just the benchmark price.
    Price memory price = oracle.resolveUsdPrice(eth);
    assertEq(price.usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(price.usdPriceDecimals, 18);
    assertEq(price.currencyDecimals, ethDecimals);
    assertEq(price.publishTime, OBSERVATIONS_TIME);
    assertEq(price.expiration, OBSERVATIONS_TIME + maxAgeSeconds);

    // The bid/ask path returns the mid plus the band from the same report.
    BidAsk memory bidAsk = oracle.resolveBidAskPrice(eth);
    assertEq(bidAsk.midPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bidAsk.bidPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bidAsk.askPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bidAsk.usdPriceDecimals, 18);
    assertEq(bidAsk.currencyDecimals, ethDecimals);
    assertEq(bidAsk.publishTime, OBSERVATIONS_TIME);
    assertEq(bidAsk.expiration, OBSERVATIONS_TIME + maxAgeSeconds);
  }

  function test_resolveBidAskReturnsDistinctBandThroughOracle() public {
    bytes32 feedId = _v3FeedId(0x0f);
    uint32 maxAgeSeconds = 60;
    int192 bidPrice = ETH_PRICE - 5e18;
    int192 askPrice = ETH_PRICE + 5e18;

    Currency memory eth = Currency({
      chainId: "ethereum",
      currency: abi.encodePacked(address(0))
    });

    vm.mockCall(
      PriceOraclePrecompile.PRECOMPILE,
      abi.encodePacked(PROVIDER_CHAINLINK, feedId),
      _fullReport(
        feedId,
        ETH_PRICE,
        bidPrice,
        askPrice,
        OBSERVATIONS_TIME,
        EXPIRES_AT
      )
    );

    vm.startPrank(owner);
    oracle.setPriceFeedAdapter(
      PROVIDER_CHAINLINK,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    oracle.setFeedRoute(eth, PROVIDER_CHAINLINK, feedId, 18, maxAgeSeconds);
    vm.stopPrank();

    BidAsk memory bidAsk = oracle.resolveBidAskPrice(eth);
    assertEq(bidAsk.midPrice, uint256(uint192(ETH_PRICE)));
    assertEq(bidAsk.bidPrice, uint256(uint192(bidPrice)));
    assertEq(bidAsk.askPrice, uint256(uint192(askPrice)));
    assertEq(bidAsk.currencyDecimals, 18);
    assertEq(bidAsk.publishTime, OBSERVATIONS_TIME);
    assertEq(bidAsk.expiration, OBSERVATIONS_TIME + maxAgeSeconds);
  }

  function test_batchVerifiesSharedFeedOnce() public {
    bytes32 feedId = _v3FeedId(0x10);
    uint32 maxAgeSeconds = 60;
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    // The same asset on two chains routes to the same provider feed.
    Currency memory ethMainnet = Currency({
      chainId: "ethereum",
      currency: abi.encodePacked(address(0))
    });
    Currency memory ethArbitrum = Currency({
      chainId: "arbitrum",
      currency: abi.encodePacked(address(0))
    });

    vm.mockCall(
      PriceOraclePrecompile.PRECOMPILE,
      abi.encodePacked(PROVIDER_CHAINLINK, feedId),
      report
    );

    vm.startPrank(owner);
    oracle.setPriceFeedAdapter(
      PROVIDER_CHAINLINK,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    oracle.setFeedRoute(
      ethMainnet,
      PROVIDER_CHAINLINK,
      feedId,
      18,
      maxAgeSeconds
    );
    oracle.setFeedRoute(
      ethArbitrum,
      PROVIDER_CHAINLINK,
      feedId,
      18,
      maxAgeSeconds
    );
    vm.stopPrank();

    // The second currency hits the cache entry written by the first, so the
    // shared feed verifies once.
    vm.expectCall(
      address(verifierProxy),
      abi.encodeWithSelector(
        IVerifierProxy.verify.selector,
        report,
        abi.encode(address(0))
      ),
      1
    );

    Currency[] memory currencies = new Currency[](2);
    currencies[0] = ethMainnet;
    currencies[1] = ethArbitrum;
    Price[] memory prices = oracle.resolveUsdPrices(currencies);

    assertEq(prices[0].usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(prices[1].usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(prices[0].expiration, OBSERVATIONS_TIME + maxAgeSeconds);
    assertEq(prices[1].expiration, OBSERVATIONS_TIME + maxAgeSeconds);
  }

  /// @notice Calls the adapter as its bound RelayPriceOracle.
  function _decodeAndVerify(
    bytes32 feedId,
    bytes memory updateData
  )
    internal
    returns (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    )
  {
    vm.prank(address(oracle));
    return adapter.decodeAndVerify(feedId, updateData);
  }

  /// @notice Builds a V3-tagged feed ID (`0x0003` prefix) from a salt.
  function _v3FeedId(uint256 salt) internal pure returns (bytes32) {
    return bytes32((uint256(0x0003) << 240) | salt);
  }

  /// @notice ABI-encodes a V3 `ReportDataV3` body with `bid = ask = benchmark`.
  function _reportBlob(
    bytes32 feedId,
    int192 benchmarkPrice,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      _reportBlob(
        feedId,
        benchmarkPrice,
        benchmarkPrice,
        benchmarkPrice,
        observationsTimestamp,
        observationsTimestamp,
        expiresAt
      );
  }

  /// @notice ABI-encodes a V3 `ReportDataV3` body with an explicit bid/ask band.
  function _reportBlob(
    bytes32 feedId,
    int192 benchmarkPrice,
    int192 bid,
    int192 ask,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      _reportBlob(
        feedId,
        benchmarkPrice,
        bid,
        ask,
        observationsTimestamp,
        observationsTimestamp,
        expiresAt
      );
  }

  /// @notice ABI-encodes a V3 report body with explicit prices and timestamps.
  function _reportBlob(
    bytes32 feedId,
    int192 benchmarkPrice,
    int192 bid,
    int192 ask,
    uint32 validFromTimestamp,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        uint192(0), // nativeFee
        uint192(0), // linkFee
        expiresAt,
        benchmarkPrice,
        bid,
        ask
      );
  }

  /// @notice Wraps a `bid = ask = benchmark` report body in the `fullReport`
  ///         envelope with empty (unverified) signatures.
  function _fullReport(
    bytes32 feedId,
    int192 benchmarkPrice,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      _fullReport(
        feedId,
        benchmarkPrice,
        benchmarkPrice,
        benchmarkPrice,
        observationsTimestamp,
        observationsTimestamp,
        expiresAt
      );
  }

  /// @notice Wraps a report with explicit timestamps in a `fullReport`.
  function _fullReport(
    bytes32 feedId,
    int192 benchmarkPrice,
    uint32 validFromTimestamp,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      _fullReport(
        feedId,
        benchmarkPrice,
        benchmarkPrice,
        benchmarkPrice,
        validFromTimestamp,
        observationsTimestamp,
        expiresAt
      );
  }

  /// @notice Wraps a report body with an explicit bid/ask band in the
  ///         `fullReport` envelope with empty (unverified) signatures.
  function _fullReport(
    bytes32 feedId,
    int192 benchmarkPrice,
    int192 bid,
    int192 ask,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      _fullReport(
        feedId,
        benchmarkPrice,
        bid,
        ask,
        observationsTimestamp,
        observationsTimestamp,
        expiresAt
      );
  }

  /// @notice Wraps a report body with explicit prices and timestamps.
  function _fullReport(
    bytes32 feedId,
    int192 benchmarkPrice,
    int192 bid,
    int192 ask,
    uint32 validFromTimestamp,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    bytes32[3] memory reportContext;
    bytes32[] memory rs = new bytes32[](0);
    bytes32[] memory ss = new bytes32[](0);
    return
      abi.encode(
        reportContext,
        _reportBlob(
          feedId,
          benchmarkPrice,
          bid,
          ask,
          validFromTimestamp,
          observationsTimestamp,
          expiresAt
        ),
        rs,
        ss,
        bytes32(0)
      );
  }
}
