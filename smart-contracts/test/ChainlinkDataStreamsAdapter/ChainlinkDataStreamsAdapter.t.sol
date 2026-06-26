// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChainlinkDataStreamsAdapter} from "../../contracts/price-adapters/ChainlinkDataStreamsAdapter.sol";
import {RelayPriceOracle} from "../../contracts/RelayPriceOracle.sol";
import {PriceOraclePrecompile} from "../../contracts/precompiles/PriceOraclePrecompile.sol";
import {
  Currency,
  Price
} from "../../contracts/deposit-addresses/open/oracle/IPricingOracle.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Tests the Chainlink Data Streams V3 price feed adapter, both in
///         isolation and wired into `RelayPriceOracle` via the mock precompile.
contract ChainlinkDataStreamsAdapterTest is BaseTest {
  ChainlinkDataStreamsAdapter internal adapter;

  bytes32 internal constant PROVIDER_CHAINLINK = keccak256("chainlink");
  uint256 internal constant NOW = 1_700_000_000;
  uint32 internal constant OBSERVATIONS_TIME = uint32(NOW - 10);
  uint32 internal constant EXPIRES_AT = uint32(NOW + 3600);
  int192 internal constant ETH_PRICE = 3_750e18;

  function setUp() public override {
    super.setUp();
    vm.warp(NOW);
    adapter = new ChainlinkDataStreamsAdapter();
  }

  function test_decodesV3Report() public view {
    bytes32 feedId = _v3FeedId(0x01);
    bytes memory report = _fullReport(
      feedId,
      ETH_PRICE,
      OBSERVATIONS_TIME,
      EXPIRES_AT
    );

    (uint256 usdPrice, uint8 usdPriceDecimals, uint256 publishTime) = adapter
      .decodeAndVerify(feedId, report);

    assertEq(usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(usdPriceDecimals, 18);
    assertEq(publishTime, OBSERVATIONS_TIME);
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
    adapter.decodeAndVerify(requestedFeedId, report);
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
    adapter.decodeAndVerify(feedId, report);
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
    adapter.decodeAndVerify(feedId, report);
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
    adapter.decodeAndVerify(feedId, report);
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
    adapter.decodeAndVerify(feedId, report);
  }

  function test_integratesWithRelayPriceOracle() public {
    bytes32 feedId = _v3FeedId(0x0e);
    uint32 maxAgeSeconds = 60;
    uint8 ethDecimals = 18;

    RelayPriceOracle oracle = new RelayPriceOracle(owner);

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
    oracle.setPriceFeedAdapter(PROVIDER_CHAINLINK, address(adapter));
    oracle.setFeedRoute(
      eth,
      PROVIDER_CHAINLINK,
      feedId,
      ethDecimals,
      maxAgeSeconds
    );
    vm.stopPrank();

    Price memory price = oracle.getUsdPrice(eth);
    assertEq(price.usdPrice, uint256(uint192(ETH_PRICE)));
    assertEq(price.usdPriceDecimals, 18);
    assertEq(price.currencyDecimals, ethDecimals);
    assertEq(price.expiration, OBSERVATIONS_TIME + maxAgeSeconds);
  }

  /// @notice Builds a V3-tagged feed ID (`0x0003` prefix) from a salt.
  function _v3FeedId(uint256 salt) internal pure returns (bytes32) {
    return bytes32((uint256(0x0003) << 240) | salt);
  }

  /// @notice ABI-encodes a V3 `ReportDataV3` body.
  function _reportBlob(
    bytes32 feedId,
    int192 benchmarkPrice,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        feedId,
        observationsTimestamp, // validFromTimestamp
        observationsTimestamp,
        uint192(0), // nativeFee
        uint192(0), // linkFee
        expiresAt,
        benchmarkPrice,
        benchmarkPrice, // bid
        benchmarkPrice // ask
      );
  }

  /// @notice Wraps a report body in the Data Streams `fullReport` envelope with
  ///         empty (unverified) signatures.
  function _fullReport(
    bytes32 feedId,
    int192 benchmarkPrice,
    uint32 observationsTimestamp,
    uint32 expiresAt
  ) internal pure returns (bytes memory) {
    bytes32[3] memory reportContext;
    bytes32[] memory rs = new bytes32[](0);
    bytes32[] memory ss = new bytes32[](0);
    return
      abi.encode(
        reportContext,
        _reportBlob(feedId, benchmarkPrice, observationsTimestamp, expiresAt),
        rs,
        ss,
        bytes32(0)
      );
  }
}
