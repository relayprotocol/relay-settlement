// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeedAdapter} from "../RelayPriceOracle.sol";

/// @title ChainlinkDataStreamsAdapter
/// @author Relay Protocol
/// @notice `IPriceFeedAdapter` for Chainlink Data Streams V3 (Crypto Streams)
///         reports. Decodes the raw `fullReport` envelope cached by the price
///         precompile and returns normalized USD price data to
///         `RelayPriceOracle`.
/// @dev Trust model: this adapter performs *structural* verification only. It
///      confirms the bytes decode as a V3 report, that the report's feed ID
///      matches the requested feed, that the benchmark price is positive, and
///      that the report has not passed its `expiresAt`. It does NOT verify the
///      DON signatures on-chain — that requires Chainlink's stateful
///      `VerifierProxy.verify` (a non-`view`, fee-paying call) and cannot run
///      from this `view` adapter. The precompile serves bytes the host ingester
///      pulled from the authenticated Data Streams feed; the on-chain
///      `VerifierProxy` verification path (for chains without the precompile)
///      is documented in `docs/data-streams-onchain-verifier.md`.
contract ChainlinkDataStreamsAdapter is IPriceFeedAdapter {
  /// @notice Schema version carried in the high 2 bytes of a feed ID for V3
  ///         (Crypto Streams) reports.
  uint16 public constant REPORT_V3_SCHEMA = 0x0003;

  /// @notice Fixed-point precision of a Data Streams V3 benchmark price.
  uint8 public constant USD_PRICE_DECIMALS = 18;

  /// @notice Thrown when the decoded report feed ID does not match the request.
  /// @param expected Feed ID requested by the caller.
  /// @param actual Feed ID decoded from the report.
  error FeedIdMismatch(bytes32 expected, bytes32 actual);

  /// @notice Thrown when the report's schema version is not V3.
  /// @param schemaVersion Schema version decoded from the report feed ID.
  error UnsupportedReportSchema(uint16 schemaVersion);

  /// @notice Thrown when the benchmark price is zero or negative.
  /// @param benchmarkPrice Non-positive price decoded from the report.
  error NonPositivePrice(int192 benchmarkPrice);

  /// @notice Thrown when the report has passed its expiration timestamp.
  /// @param expiresAt Report's expiration timestamp.
  /// @param blockTimestamp Current block timestamp.
  error ReportExpired(uint32 expiresAt, uint256 blockTimestamp);

  /// @inheritdoc IPriceFeedAdapter
  /// @dev `updateData` is a Chainlink Data Streams `fullReport`:
  ///      `(bytes32[3] reportContext, bytes reportBlob, bytes32[] rs,
  ///      bytes32[] ss, bytes32 rawVs)`, where `reportBlob` is a V3
  ///      `ReportDataV3`:
  ///      `(bytes32 feedId, uint32 validFromTimestamp,
  ///      uint32 observationsTimestamp, uint192 nativeFee, uint192 linkFee,
  ///      uint32 expiresAt, int192 benchmarkPrice, int192 bid, int192 ask)`.
  function decodeAndVerify(
    bytes32 feedId,
    bytes calldata updateData
  )
    external
    view
    returns (uint256 usdPrice, uint8 usdPriceDecimals, uint256 publishTime)
  {
    (
      bytes32 reportFeedId,
      uint32 observationsTimestamp,
      uint32 expiresAt,
      int192 benchmarkPrice
    ) = _decodeReport(updateData);

    if (reportFeedId != feedId) {
      revert FeedIdMismatch(feedId, reportFeedId);
    }

    uint16 schemaVersion = uint16(uint256(reportFeedId) >> 240);
    if (schemaVersion != REPORT_V3_SCHEMA) {
      revert UnsupportedReportSchema(schemaVersion);
    }

    if (benchmarkPrice <= 0) {
      revert NonPositivePrice(benchmarkPrice);
    }

    if (block.timestamp > expiresAt) {
      revert ReportExpired(expiresAt, block.timestamp);
    }

    usdPrice = uint256(uint192(benchmarkPrice));
    usdPriceDecimals = USD_PRICE_DECIMALS;
    publishTime = observationsTimestamp;
  }

  /// @notice Decodes the `fullReport` envelope and its V3 report body, keeping
  ///         only the fields used for pricing.
  /// @param updateData Chainlink Data Streams `fullReport` bytes.
  /// @return reportFeedId Feed ID declared in the report body.
  /// @return observationsTimestamp Report's latest observation timestamp.
  /// @return expiresAt Timestamp after which the report is no longer valid.
  /// @return benchmarkPrice Benchmark price, scaled by `USD_PRICE_DECIMALS`.
  function _decodeReport(
    bytes calldata updateData
  )
    private
    pure
    returns (
      bytes32 reportFeedId,
      uint32 observationsTimestamp,
      uint32 expiresAt,
      int192 benchmarkPrice
    )
  {
    // Unwrap the signed envelope; only the report body is needed here.
    (, bytes memory reportBlob, , , ) = abi.decode(
      updateData,
      (bytes32[3], bytes, bytes32[], bytes32[], bytes32)
    );

    // Skip the fields not used for pricing: validFromTimestamp, nativeFee,
    // linkFee, bid, ask.
    (
      reportFeedId,
      ,
      observationsTimestamp,
      ,
      ,
      expiresAt,
      benchmarkPrice,
      ,

    ) = abi.decode(
        reportBlob,
        (
          bytes32,
          uint32,
          uint32,
          uint192,
          uint192,
          uint32,
          int192,
          int192,
          int192
        )
      );
  }
}
