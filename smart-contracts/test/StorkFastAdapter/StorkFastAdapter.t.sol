// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  IStorkFastVerifier,
  StorkFastAdapter
} from "../../contracts/price-adapters/StorkFastAdapter.sol";
import {MockStorkFastVerifier} from "../../contracts/mocks/MockStorkFastVerifier.sol";
import {RelayPriceOracle} from "../../contracts/RelayPriceOracle.sol";
import {PriceOraclePrecompile} from "../../contracts/precompiles/PriceOraclePrecompile.sol";
import {
  BidAsk,
  Currency,
  Price
} from "../../contracts/deposit-addresses/open/oracle/IPricingOracle.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Tests the Stork Fast price feed adapter, both in isolation and
///         wired into `RelayPriceOracle` via the mock precompile.
contract StorkFastAdapterTest is BaseTest {
  StorkFastAdapter internal adapter;
  MockStorkFastVerifier internal verifier;

  bytes32 internal constant PROVIDER_STORK = keccak256("stork");
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
    adapter = new StorkFastAdapter(verifier);
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
    ) = adapter.decodeAndVerify(ethFeedId, payload);

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
    adapter.decodeAndVerify(ethFeedId, otherAssetPayload);

    vm.expectRevert(expectedError);
    adapter.decodeAndVerify(ethFeedId, otherTaxonomyPayload);

    vm.expectRevert(expectedError);
    adapter.decodeAndVerify(ethFeedId, emptyPayload);
  }

  function test_batchCachesAllContainedFeeds() public {
    int128 btcPrice = 65_000e18;
    bytes memory payload = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(BTC_ASSET_ID, btcPrice)
      )
    );

    (uint256 usdPrice, , , , ) = adapter.decodeAndVerify(ethFeedId, payload);
    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));

    // The first verification cached every feed in the batch, so the sibling
    // feed must be served without another verifier call.
    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );

    uint256 publishTime;
    (usdPrice, , , , publishTime) = adapter.decodeAndVerify(btcFeedId, payload);
    assertEq(usdPrice, uint256(uint128(btcPrice)));
    assertEq(publishTime, PUBLISH_TIME);
  }

  function test_duplicateAssetIdLastOccurrenceWins() public {
    int128 newerPrice = ETH_PRICE + 1e18;
    bytes memory payload = _signedBatch(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      abi.encodePacked(
        _asset(ETH_ASSET_ID, ETH_PRICE),
        _asset(ETH_ASSET_ID, newerPrice)
      )
    );

    (uint256 usdPrice, , , , ) = adapter.decodeAndVerify(ethFeedId, payload);
    assertEq(usdPrice, uint256(uint128(newerPrice)));
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
    adapter.decodeAndVerify(ethFeedId, zeroPayload);

    vm.expectRevert(
      abi.encodeWithSelector(
        StorkFastAdapter.NonPositivePrice.selector,
        int192(-1)
      )
    );
    adapter.decodeAndVerify(ethFeedId, negativePayload);
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

    adapter.decodeAndVerify(ethFeedId, payload);

    // Any further verification attempt reverts, so success below proves the
    // adapter served the decoded values from its cache.
    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );

    (uint256 usdPrice, , , , uint256 publishTime) = adapter.decodeAndVerify(
      ethFeedId,
      payload
    );
    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(publishTime, PUBLISH_TIME);

    // The cache is keyed per feed, so another feed's first use must verify.
    vm.expectRevert(bytes("verify must not be called"));
    adapter.decodeAndVerify(btcFeedId, btcPayload);
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

    adapter.decodeAndVerify(ethFeedId, oldPayload);

    vm.expectCall(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector,
        newPayload
      ),
      1
    );
    (uint256 usdPrice, , , , uint256 publishTime) = adapter.decodeAndVerify(
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
    (usdPrice, , , , ) = adapter.decodeAndVerify(ethFeedId, newPayload);
    assertEq(usdPrice, uint256(uint128(newPrice)));

    vm.expectRevert(bytes("verify must not be called"));
    adapter.decodeAndVerify(ethFeedId, oldPayload);
  }

  function test_exposesCachedReport() public {
    bytes memory payload = _signedPayload(
      TAXONOMY_ID,
      TIMESTAMP_NS,
      ETH_ASSET_ID,
      ETH_PRICE
    );

    adapter.decodeAndVerify(ethFeedId, payload);

    (bytes32 reportHash, int192 quantizedValue, uint64 publishTime) = adapter
      .cachedReports(ethFeedId);

    assertEq(reportHash, keccak256(payload));
    assertEq(quantizedValue, int192(ETH_PRICE));
    assertEq(publishTime, uint64(PUBLISH_TIME));
  }

  function test_integratesWithRelayPriceOracle() public {
    uint32 maxAgeSeconds = 60;
    uint8 ethDecimals = 18;

    RelayPriceOracle oracle = new RelayPriceOracle(owner);

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
    oracle.setPriceFeedAdapter(PROVIDER_STORK, address(adapter));
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
    assertEq(price.expiration, PUBLISH_TIME + maxAgeSeconds);

    // The bid/ask path reports the band as unavailable.
    BidAsk memory bidAsk = oracle.resolveBidAskPrice(eth);
    assertEq(bidAsk.midPrice, uint256(uint128(ETH_PRICE)));
    assertEq(bidAsk.bidPrice, 0);
    assertEq(bidAsk.askPrice, 0);
    assertEq(bidAsk.usdPriceDecimals, 18);
    assertEq(bidAsk.currencyDecimals, ethDecimals);
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

    RelayPriceOracle oracle = new RelayPriceOracle(owner);

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
    oracle.setPriceFeedAdapter(PROVIDER_STORK, address(adapter));
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
    assertEq(prices[0].expiration, PUBLISH_TIME + maxAgeSeconds);
    assertEq(prices[1].expiration, PUBLISH_TIME + maxAgeSeconds);
  }

  function test_omittedAssetKeepsServingOlderPayload() public {
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

    adapter.decodeAndVerify(ethFeedId, oldBoth);
    adapter.decodeAndVerify(btcFeedId, newBtcOnly);

    (bytes32 ethHash, , ) = adapter.cachedReports(ethFeedId);
    assertEq(ethHash, keccak256(oldBoth));

    vm.mockCallRevert(
      address(verifier),
      abi.encodeWithSelector(
        IStorkFastVerifier.verifyAndDeserializeSignedECDSAPayload.selector
      ),
      "verify must not be called"
    );
    (uint256 usdPrice, , , , uint256 publishTime) = adapter.decodeAndVerify(
      ethFeedId,
      oldBoth
    );
    assertEq(usdPrice, uint256(uint128(ETH_PRICE)));
    assertEq(publishTime, PUBLISH_TIME);
    vm.clearMockedCalls();

    adapter.decodeAndVerify(ethFeedId, midBoth);
    (bytes32 btcHash, , ) = adapter.cachedReports(btcFeedId);
    assertEq(btcHash, keccak256(midBoth));

    (usdPrice, , , , publishTime) = adapter.decodeAndVerify(
      btcFeedId,
      newBtcOnly
    );
    assertEq(usdPrice, uint256(uint128(btcPrice + 2e18)));
    assertEq(publishTime, PUBLISH_TIME + 2);
  }

  function test_largeBatchCachesAllAssetsLinearGas() public {
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
    (uint256 usdPrice, , , , ) = adapter.decodeAndVerify(midFeedId, payload);
    uint256 gasUsed = gasBefore - gasleft();

    assertEq(usdPrice, uint256(assetCount / 2) * 1e18);

    (bytes32 firstHash, , ) = adapter.cachedReports(_feedId(TAXONOMY_ID, 1));
    (bytes32 lastHash, , ) = adapter.cachedReports(
      _feedId(TAXONOMY_ID, assetCount)
    );
    assertEq(firstHash, keccak256(payload));
    assertEq(lastHash, keccak256(payload));

    assertLt(gasUsed, uint256(assetCount) * 60_000);
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
