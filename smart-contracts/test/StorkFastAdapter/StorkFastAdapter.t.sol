// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  IStorkFastVerifier,
  StorkFastAdapter
} from "../../contracts/price-adapters/StorkFastAdapter.sol";
import {MockStorkFastVerifier} from "../../contracts/mocks/MockStorkFastVerifier.sol";
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

/// @notice Tests the Stork Fast price feed adapter, both in isolation and
///         wired into `RelayPriceOracle` via the mock precompile.
contract StorkFastAdapterTest is BaseTest {
  StorkFastAdapter internal adapter;
  MockStorkFastVerifier internal verifier;
  RelayPriceOracle internal oracle;

  bytes32 internal constant PROVIDER_STORK = keccak256("stork");
  uint32 internal constant MAX_FUTURE_SECONDS = 12;
  uint16 internal constant TAXONOMY_ID = 1;
  uint16 internal constant ETH_ASSET_ID = 42;
  uint16 internal constant BTC_ASSET_ID = 43;
  uint256 internal constant NOW = 1_700_000_000;
  uint256 internal constant PUBLISH_TIME = NOW - 10;
  uint64 internal constant TIMESTAMP_NS = uint64(PUBLISH_TIME * 1e9);
  int128 internal constant ETH_PRICE = 3_750e18;

  bytes32 internal ethFeedId = _feedId(TAXONOMY_ID, ETH_ASSET_ID);
  bytes32 internal btcFeedId = _feedId(TAXONOMY_ID, BTC_ASSET_ID);

  function setUp() public override {
    super.setUp();
    vm.warp(NOW);
    verifier = new MockStorkFastVerifier();
    oracle = new RelayPriceOracle(owner);
    adapter = new StorkFastAdapter(address(oracle), verifier);
  }

  function test_computesFeedIdFromPair() public view {
    assertEq(
      adapter.computeFeedId(TAXONOMY_ID, ETH_ASSET_ID),
      keccak256(abi.encodePacked(TAXONOMY_ID, ETH_ASSET_ID))
    );
    // Golden vector shared with the ingester's `fast_feed_id` tests.
    assertEq(
      adapter.computeFeedId(1, 42),
      0xa301ac32868bda4a03c9abfd150992bc94b21c1088a05b5eacfe201ecb27d47f
    );
    // Fixed-width encoding keeps adjacent pairs from sharing a preimage.
    assertNotEq(adapter.computeFeedId(14, 48), adapter.computeFeedId(1, 448));
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
    new StorkFastAdapter(address(0), verifier);
  }

  function test_rejectsUnauthorizedCaller() public {
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        IPriceFeedAdapter.UnauthorizedCaller.selector,
        address(this)
      )
    );
    adapter.decodeAndVerify(ethFeedId, payload);
  }

  function test_decodesSignedPayload() public {
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );

    (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    ) = _decodeAndVerify(ethFeedId, payload);

    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));
    // Fast payloads carry no bid/ask band, so it is reported as unavailable.
    assertEq(bid, 0);
    assertEq(ask, 0);
    assertEq(usdPriceDecimals, 18);
    // The nanosecond payload timestamp is truncated to Unix seconds.
    assertEq(publishTime, PUBLISH_TIME);
  }

  function test_revertsWhenFeedNotInPayload() public {
    // Another asset, another taxonomy, and an empty batch all lack an asset
    // hashing to the requested feed id.
    bytes memory otherAssetPayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      BTC_ASSET_ID,
      ETH_PRICE
    );
    bytes memory otherTaxonomyPayload = _signedPayload(
      TAXONOMY_ID + 1,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );
    bytes memory emptyPayload = _signedBatch(TAXONOMY_ID, TIMESTAMP_NS, "");

    bytes memory expectedError = abi.encodeWithSelector(
      StorkFastAdapter.FeedNotInPayload.selector,
      ethFeedId
    );

    vm.expectRevert(expectedError);
    _decodeAndVerify(ethFeedId, otherAssetPayload);

    vm.expectRevert(expectedError);
    _decodeAndVerify(ethFeedId, otherTaxonomyPayload);

    vm.expectRevert(expectedError);
    _decodeAndVerify(ethFeedId, emptyPayload);
  }

  function test_globalCacheServesSiblingFeed() public {
    int128 btcPrice = 65_000e18;
    bytes memory payload = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(BTC_ASSET_ID, btcPrice)
      )
    );

    (uint256 usdPrice, , , , ) = _decodeAndVerify(ethFeedId, payload);
    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(adapter.cachedReportHash(), keccak256(payload));

    (int192 ethValue, uint64 ethTimestampNs) = adapter.cachedReportValues(
      ethFeedId
    );
    assertEq(ethValue, int192(ETH_PRICE));
    assertEq(ethTimestampNs, TIMESTAMP_NS);

    // Unused sibling report values are not written to storage.
    (int192 btcValue, uint64 btcTimestampNs) = adapter.cachedReportValues(
      btcFeedId
    );
    assertEq(btcValue, 0);
    assertEq(btcTimestampNs, 0);

    // The global hash lets a sibling feed use the same verified payload
    // without another verifier call.
    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );

    uint256 publishTime;
    (usdPrice, , , , publishTime) = _decodeAndVerify(btcFeedId, payload);
    assertEq(usdPrice, uint256(uint128(btcPrice)));
    assertEq(publishTime, PUBLISH_TIME);

    (btcValue, btcTimestampNs) = adapter.cachedReportValues(btcFeedId);
    assertEq(btcValue, int192(btcPrice));
    assertEq(btcTimestampNs, TIMESTAMP_NS);
  }

  function test_globalCacheRejectsNegativeSiblingPrice() public {
    bytes memory payload = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(BTC_ASSET_ID, -1)
      )
    );

    _decodeAndVerify(ethFeedId, payload);

    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.NonPositivePrice.selector,
        int192(-1)
      )
    );
    _decodeAndVerify(btcFeedId, payload);

    (, uint64 btcTimestampNs) = adapter.cachedReportValues(btcFeedId);
    assertEq(btcTimestampNs, 0);
  }

  function test_rejectsDuplicateAssetIds() public {
    bytes memory identicalValues = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(ETH_ASSET_ID, ETH_PRICE)
      )
    );
    bytes memory differentValues = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(ETH_ASSET_ID, ETH_PRICE + 1e18)
      )
    );

    bytes memory expectedError = abi.encodeWithSelector(
      StorkFastAdapter.DuplicateAssetId.selector,
      ETH_ASSET_ID
    );

    vm.expectRevert(expectedError);
    _decodeAndVerify(ethFeedId, identicalValues);

    vm.expectRevert(expectedError);
    _decodeAndVerify(ethFeedId, differentValues);

    assertEq(adapter.cachedReportHash(), bytes32(0));
    (, uint64 timestampNs) = adapter.cachedReportValues(ethFeedId);
    assertEq(timestampNs, 0);
  }

  function test_acceptsNewerNanosecondsWithinSameSecond() public {
    uint64 firstTimestampNs = TIMESTAMP_NS + 100_000_000;
    uint64 secondTimestampNs = TIMESTAMP_NS + 900_000_000;
    int128 newerPrice = ETH_PRICE + 1e18;

    _decodeAndVerify(
      ethFeedId,
      _signedPayload(TAXONOMY_ID, firstTimestampNs, ETH_ASSET_ID, ETH_PRICE)
    );
    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      ethFeedId,
      _signedPayload(TAXONOMY_ID, secondTimestampNs, ETH_ASSET_ID, newerPrice)
    );

    assertEq(usdPrice, uint256(uint128(newerPrice)));
    assertEq(publishTime, PUBLISH_TIME);
    (, uint64 cachedTimestampNs) = adapter.cachedReportValues(ethFeedId);
    assertEq(cachedTimestampNs, secondTimestampNs);
  }

  function test_rejectsOlderNanosecondsWithinSameSecond() public {
    uint64 latestTimestampNs = TIMESTAMP_NS + 900_000_000;
    uint64 olderTimestampNs = TIMESTAMP_NS + 100_000_000;

    _decodeAndVerify(
      ethFeedId,
      _signedPayload(TAXONOMY_ID, latestTimestampNs, ETH_ASSET_ID, ETH_PRICE)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.TimestampRollback.selector,
        ethFeedId,
        olderTimestampNs,
        latestTimestampNs
      )
    );
    _decodeAndVerify(
      ethFeedId,
      _signedPayload(
        TAXONOMY_ID,
        olderTimestampNs,
        ETH_ASSET_ID,
        ETH_PRICE + 1e18
      )
    );
  }

  function test_allowsSamePriceAtSameTimestamp() public {
    int128 btcPrice = 65_000e18;
    bytes memory ethOnly = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );
    bytes memory ethAndBtc = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(BTC_ASSET_ID, btcPrice)
      )
    );

    _decodeAndVerify(ethFeedId, ethOnly);
    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      btcFeedId,
      ethAndBtc
    );

    assertEq(usdPrice, uint256(uint128(btcPrice)));
    assertEq(publishTime, PUBLISH_TIME);
    assertEq(adapter.cachedReportHash(), keccak256(ethAndBtc));
    (, uint64 ethTimestampNs) = adapter.cachedReportValues(ethFeedId);
    assertEq(ethTimestampNs, TIMESTAMP_NS);
  }

  function test_rejectsConflictingPriceAtSameTimestamp() public {
    int128 conflictingPrice = ETH_PRICE + 1e18;
    _decodeAndVerify(
      ethFeedId,
      _signedPayload(TAXONOMY_ID, TIMESTAMP_NS, ETH_ASSET_ID, ETH_PRICE)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.ConflictingPriceAtTimestamp.selector,
        ethFeedId,
        TIMESTAMP_NS,
        int192(ETH_PRICE),
        int192(conflictingPrice)
      )
    );
    _decodeAndVerify(
      ethFeedId,
      _signedPayload(TAXONOMY_ID, TIMESTAMP_NS, ETH_ASSET_ID, conflictingPrice)
    );
  }

  function test_conflictingBatchDoesNotAdvanceCache() public {
    int128 btcPrice = 65_000e18;
    bytes memory acceptedPayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );
    _decodeAndVerify(ethFeedId, acceptedPayload);

    bytes memory conflictingBatch = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(BTC_ASSET_ID, btcPrice),
        _asset(ETH_ASSET_ID, ETH_PRICE + 1e18)
      )
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.ConflictingPriceAtTimestamp.selector,
        ethFeedId,
        TIMESTAMP_NS,
        int192(ETH_PRICE),
        int192(ETH_PRICE + 1e18)
      )
    );
    _decodeAndVerify(btcFeedId, conflictingBatch);

    assertEq(adapter.cachedReportHash(), keccak256(acceptedPayload));
    (, uint64 btcTimestampNs) = adapter.cachedReportValues(btcFeedId);
    assertEq(btcTimestampNs, 0);
  }

  function test_revertsOnNonPositivePrice() public {
    bytes memory zeroPayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      0
    );
    bytes memory negativePayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      -1
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.NonPositivePrice.selector,
        int192(0)
      )
    );
    _decodeAndVerify(ethFeedId, zeroPayload);

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.NonPositivePrice.selector,
        int192(-1)
      )
    );
    _decodeAndVerify(ethFeedId, negativePayload);
  }

  function test_cacheHitSkipsVerifier() public {
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );
    bytes memory btcPayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      BTC_ASSET_ID,
      ETH_PRICE + 1e18
    );

    _decodeAndVerify(ethFeedId, payload);

    // Any further verification attempt reverts, so success below proves the
    // adapter served the decoded values from its cache.
    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );

    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      ethFeedId,
      payload
    );
    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(publishTime, PUBLISH_TIME);

    // A different payload still requires verification even for another feed.
    vm.expectRevert(bytes("verify must not be called"));
    _decodeAndVerify(btcFeedId, btcPayload);
  }

  function test_reverifiesWhenReportChanges() public {
    bytes memory oldPayload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );
    int128 newPrice = ETH_PRICE + 100e18;
    uint64 newTimestampNs = TIMESTAMP_NS + 5e9;
    bytes memory newPayload = _signedPayload(
      TAXONOMY_ID,
      newTimestampNs,
      ETH_ASSET_ID,
      newPrice
    );

    _decodeAndVerify(ethFeedId, oldPayload);

    vm.expectCall(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector,
        newPayload
      ),
      1
    );
    (uint256 usdPrice, , , , uint256 publishTime) = _decodeAndVerify(
      ethFeedId,
      newPayload
    );
    assertEq(usdPrice, uint256(uint128(newPrice)));
    assertEq(publishTime, PUBLISH_TIME + 5);

    // The new payload overwrote the cache entry, so only the old payload
    // would re-verify.
    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );
    (usdPrice, , , , ) = _decodeAndVerify(ethFeedId, newPayload);
    assertEq(usdPrice, uint256(uint128(newPrice)));

    vm.expectRevert(bytes("verify must not be called"));
    _decodeAndVerify(ethFeedId, oldPayload);
  }

  function test_exposesCachedReportHashAndValues() public {
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );

    _decodeAndVerify(ethFeedId, payload);

    (int192 quantizedValue, uint64 timestampNs) = adapter.cachedReportValues(
      ethFeedId
    );

    assertEq(adapter.cachedReportHash(), keccak256(payload));
    assertEq(quantizedValue, int192(ETH_PRICE));
    assertEq(timestampNs, TIMESTAMP_NS);
  }

  function test_integratesWithRelayPriceOracle() public {
    uint32 maxAgeSeconds = 60;
    uint8 ethDecimals = 18;

    Currency memory eth = Currency({
      chainId: "ethereum",
      currency: abi.encodePacked(address(0))
    });

    vm.mockCall(
      PriceOraclePrecompile.PRECOMPILE,
      abi.encodePacked(PROVIDER_STORK, ethFeedId),
      _signedPayload(TAXONOMY_ID, TIMESTAMP_NS, ETH_ASSET_ID, ETH_PRICE)
    );

    vm.startPrank(owner);
    oracle.setPriceFeedAdapter(
      PROVIDER_STORK,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    oracle.setFeedRoute(
      eth,
      PROVIDER_STORK,
      ethFeedId,
      ethDecimals,
      maxAgeSeconds
    );
    vm.stopPrank();

    // The mid-only path returns the quantized value.
    Price memory price = oracle.resolveUsdPrice(eth);
    assertEq(price.usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(price.usdPriceDecimals, 18);
    assertEq(price.currencyDecimals, ethDecimals);
    assertEq(price.publishTime, PUBLISH_TIME);
    assertEq(price.expiration, PUBLISH_TIME + maxAgeSeconds);

    // The bid/ask path reports the band as unavailable.
    BidAsk memory bidAsk = oracle.resolveBidAskPrice(eth);
    assertEq(bidAsk.midPrice, uint256(uint128(ETH_PRICE)));
    assertEq(bidAsk.bidPrice, 0);
    assertEq(bidAsk.askPrice, 0);
    assertEq(bidAsk.usdPriceDecimals, 18);
    assertEq(bidAsk.currencyDecimals, ethDecimals);
    assertEq(bidAsk.publishTime, PUBLISH_TIME);
    assertEq(bidAsk.expiration, PUBLISH_TIME + maxAgeSeconds);
  }

  function test_batchVerifiesSharedFeedOnce() public {
    uint32 maxAgeSeconds = 60;
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
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
      abi.encodePacked(PROVIDER_STORK, ethFeedId),
      payload
    );

    vm.startPrank(owner);
    oracle.setPriceFeedAdapter(
      PROVIDER_STORK,
      address(adapter),
      MAX_FUTURE_SECONDS
    );
    oracle.setFeedRoute(
      ethMainnet,
      PROVIDER_STORK,
      ethFeedId,
      18,
      maxAgeSeconds
    );
    oracle.setFeedRoute(
      ethArbitrum,
      PROVIDER_STORK,
      ethFeedId,
      18,
      maxAgeSeconds
    );
    vm.stopPrank();

    // The second currency hits the cache entry written by the first, so the
    // shared feed verifies once.
    vm.expectCall(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector,
        payload
      ),
      1
    );

    Currency[] memory currencies = new Currency[](2);
    currencies[0] = ethMainnet;
    currencies[1] = ethArbitrum;
    Price[] memory prices = oracle.resolveUsdPrices(currencies);

    assertEq(prices[0].usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(prices[1].usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(prices[0].publishTime, PUBLISH_TIME);
    assertEq(prices[1].publishTime, PUBLISH_TIME);
    assertEq(prices[0].expiration, PUBLISH_TIME + maxAgeSeconds);
    assertEq(prices[1].expiration, PUBLISH_TIME + maxAgeSeconds);
  }

  function test_batchRollbackDoesNotAdvanceState() public {
    int128 btcPrice = 65_000e18;
    bytes memory oldBoth = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(BTC_ASSET_ID, btcPrice)
      )
    );
    bytes memory midBoth = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS + 1e9,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE + 1e18),
        _asset(BTC_ASSET_ID, btcPrice + 1e18)
      )
    );
    bytes memory newBtcOnly = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS + 2e9,
      abi.encodePacked(_asset(BTC_ASSET_ID, btcPrice + 2e18))
    );

    _decodeAndVerify(ethFeedId, oldBoth);
    _decodeAndVerify(btcFeedId, newBtcOnly);

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.TimestampRollback.selector,
        btcFeedId,
        TIMESTAMP_NS + 1e9,
        TIMESTAMP_NS + 2e9
      )
    );
    _decodeAndVerify(ethFeedId, midBoth);

    assertEq(adapter.cachedReportHash(), keccak256(newBtcOnly));

    (int192 ethValue, uint64 ethTimestampNs) = adapter.cachedReportValues(
      ethFeedId
    );
    assertEq(ethValue, int192(ETH_PRICE));
    assertEq(ethTimestampNs, TIMESTAMP_NS);

    (int192 btcValue, uint64 btcTimestampNs) = adapter.cachedReportValues(
      btcFeedId
    );
    assertEq(btcValue, int192(btcPrice + 2e18));
    assertEq(btcTimestampNs, TIMESTAMP_NS + 2e9);
  }

  function test_largeBatchCachesOnlyRequestedFeed() public {
    uint16 assetCount = 200;
    bytes memory assetsBlob;
    for (uint16 id = 1; id <= assetCount; ++id) {
      assetsBlob = bytes.concat(
        assetsBlob,
        _asset(id, int128(uint128(id)) * 1e18)
      );
    }
    bytes memory payload = _signedBatch(TAXONOMY_ID, TIMESTAMP_NS, assetsBlob);
    bytes32 midFeedId = _feedId(TAXONOMY_ID, assetCount / 2);

    uint256 gasBefore = gasleft();
    (uint256 usdPrice, , , , ) = _decodeAndVerify(midFeedId, payload);
    uint256 gasUsed = gasBefore - gasleft();

    assertEq(usdPrice, uint256(assetCount / 2) * 1e18);

    assertEq(adapter.cachedReportHash(), keccak256(payload));

    (, uint64 firstTimestampNs) = adapter.cachedReportValues(
      _feedId(TAXONOMY_ID, 1)
    );
    (int192 midValue, uint64 midTimestampNs) = adapter.cachedReportValues(
      midFeedId
    );
    (, uint64 lastTimestampNs) = adapter.cachedReportValues(
      _feedId(TAXONOMY_ID, assetCount)
    );
    assertEq(firstTimestampNs, 0);
    assertEq(midValue, int192(uint192(assetCount / 2) * 1e18));
    assertEq(midTimestampNs, TIMESTAMP_NS);
    assertEq(lastTimestampNs, 0);

    assertLt(gasUsed, uint256(assetCount) * 20_000);
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

  /// @notice Computes a Stork Fast feed id from its identifying pair.
  function _feedId(
    uint16 taxonomyId,
    uint16 assetId
  ) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(taxonomyId, assetId));
  }

  /// @notice Builds a `signed_ecdsa` payload with a zeroed (unverified)
  ///         signature around a packed asset list.
  function _signedBatch(
    uint16 taxonomyId,
    uint64 timestampNs,
    bytes memory assets
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(new bytes(65), taxonomyId, timestampNs, assets);
  }

  /// @notice Packs one 18-byte asset entry.
  function _asset(
    uint16 assetId,
    int128 quantizedValue
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(assetId, uint128(quantizedValue));
  }

  /// @notice Builds a batch-of-one `signed_ecdsa` payload.
  function _signedPayload(
    uint16 taxonomyId,
    uint64 timestampNs,
    uint16 assetId,
    int128 quantizedValue
  ) internal pure returns (bytes memory) {
    return
      _signedBatch(taxonomyId, timestampNs, _asset(assetId, quantizedValue));
  }
}
