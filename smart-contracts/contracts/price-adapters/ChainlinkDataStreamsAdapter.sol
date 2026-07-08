// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeedAdapter} from "../RelayPriceOracle.sol";

/// @title IVerifierProxy
/// @author Relay Protocol
/// @notice Minimal interface for Chainlink's Data Streams `VerifierProxy`.
/// @dev Matches the v0.3.0 reference contract. `verify` checks the report's
///      DON signatures against the verifier's registered config, routes the
///      verification fee, and returns the decoded report body. It is
///      state-changing and (for native fees) payable, so it cannot be reached
///      from a `view`/`staticcall` context.
interface IVerifierProxy {
  /// @notice Verifies a signed Data Streams report on-chain.
  /// @param payload Full report envelope (`fullReport`) as served by the feed.
  /// @param parameterPayload Fee metadata; for v0.3.0 the ABI-encoded fee-token
  ///        address (LINK or the native fee token).
  /// @return verifierResponse The verified, decoded report body (`ReportDataV3`).
  function verify(
    bytes calldata payload,
    bytes calldata parameterPayload
  ) external payable returns (bytes memory verifierResponse);
}

/// @title ChainlinkDataStreamsAdapter
/// @author Relay Protocol
/// @notice `IPriceFeedAdapter` for Chainlink Data Streams V3 (Crypto Streams)
///         reports. Verifies the raw `fullReport` envelope cached by the price
///         precompile against Chainlink's on-chain `VerifierProxy`, then
///         returns normalized USD price data to `RelayPriceOracle`.
/// @dev Trust model: this adapter performs **on-chain DON-signature
///      verification**. It forwards the cached `fullReport` to
///      `VerifierProxy.verify`, which checks the report's signatures against
///      the verifier's registered config and returns the decoded report body.
///      Because `verify` is state-changing and fee-paying, `decodeAndVerify`
///      (and the `RelayPriceOracle` read path above it) are **not** `view`.
///      On top of the signature check the adapter still applies structural
///      validation: the verified report's feed ID matches the request, its
///      schema is V3, its benchmark price is positive, and it has not passed
///      its `expiresAt`.
///
///      Fees: `verify` routes a fee through Chainlink's `FeeManager` in
///      `feeToken`. This adapter assumes either a zero-fee config or a LINK-fee
///      config the adapter is pre-funded and pre-approved for (see
///      `docs/data-streams-onchain-verifier.md`). Native (value-bearing) fees
///      would require a `payable` path end-to-end and are out of scope here.
contract ChainlinkDataStreamsAdapter is IPriceFeedAdapter {
  /// @notice Schema version carried in the high 2 bytes of a feed ID for V3
  ///         (Crypto Streams) reports.
  uint16 public constant REPORT_V3_SCHEMA = 0x0003;

  /// @notice Fixed-point precision of a Data Streams V3 benchmark price.
  uint8 public constant USD_PRICE_DECIMALS = 18;

  /// @notice Chainlink `VerifierProxy` that checks DON signatures on-chain.
  IVerifierProxy public immutable VERIFIER_PROXY;

  /// @notice Fee token passed to `VerifierProxy.verify` (LINK or native fee token).
  address public immutable FEE_TOKEN;

  /// @notice Thrown when the verifier proxy address is zero.
  error InvalidVerifierProxy();

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

  /// @notice Deploys the adapter bound to a Chainlink `VerifierProxy`.
  /// @param verifierProxy Chainlink Data Streams `VerifierProxy` to verify against.
  /// @param feeToken Fee token forwarded to `verify` (LINK or native fee token).
  constructor(IVerifierProxy verifierProxy, address feeToken) {
    if (address(verifierProxy) == address(0)) {
      revert InvalidVerifierProxy();
    }
    VERIFIER_PROXY = verifierProxy;
    FEE_TOKEN = feeToken;
  }

  /// @inheritdoc IPriceFeedAdapter
  /// @dev `updateData` is a Chainlink Data Streams `fullReport`:
  ///      `(bytes32[3] reportContext, bytes reportBlob, bytes32[] rs,
  ///      bytes32[] ss, bytes32 rawVs)`. It is forwarded verbatim to
  ///      `VerifierProxy.verify`, which checks the DON signatures and returns
  ///      the decoded V3 `ReportDataV3` body:
  ///      `(bytes32 feedId, uint32 validFromTimestamp,
  ///      uint32 observationsTimestamp, uint192 nativeFee, uint192 linkFee,
  ///      uint32 expiresAt, int192 benchmarkPrice, int192 bid, int192 ask)`.
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
    )
  {
    // On-chain DON-signature verification. `verify` reverts unless the report
    // is signed by the verifier's configured DON; it returns the decoded
    // report body (not the signed envelope).
    bytes memory verifiedReport = VERIFIER_PROXY.verify(
      updateData,
      abi.encode(FEE_TOKEN)
    );

    (
      bytes32 reportFeedId,
      uint32 observationsTimestamp,
      uint32 expiresAt,
      int192 benchmarkPrice,
      int192 reportBid,
      int192 reportAsk
    ) = _decodeReport(verifiedReport);

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

    // The DON-verified report carries the consensus benchmark (mid) price plus
    // the bid/ask band; surface all three so consumers can use the liquidity
    // distribution, not just the mid. A V3 report always includes bid/ask, but
    // if a feed omits either side (non-positive), report the band as fully
    // unavailable (`bid == ask == 0`) rather than a one-sided band. This holds
    // the consumer invariant: either `bid == ask == 0` (unavailable) or
    // `bid <= usdPrice <= ask` (ordering guaranteed by the verified report).
    usdPrice = uint256(uint192(benchmarkPrice));
    if (reportBid > 0 && reportAsk > 0) {
      bid = uint256(uint192(reportBid));
      ask = uint256(uint192(reportAsk));
    }
    usdPriceDecimals = USD_PRICE_DECIMALS;
    publishTime = observationsTimestamp;
  }

  /// @notice Decodes a verified V3 report body, keeping only the pricing fields.
  /// @param verifiedReport Decoded `ReportDataV3` body returned by `verify`.
  /// @return reportFeedId Feed ID declared in the report body.
  /// @return observationsTimestamp Report's latest observation timestamp.
  /// @return expiresAt Timestamp after which the report is no longer valid.
  /// @return benchmarkPrice Benchmark (mid) price, scaled by `USD_PRICE_DECIMALS`.
  /// @return bid Best bid price, scaled by `USD_PRICE_DECIMALS`.
  /// @return ask Best ask price, scaled by `USD_PRICE_DECIMALS`.
  function _decodeReport(
    bytes memory verifiedReport
  )
    private
    pure
    returns (
      bytes32 reportFeedId,
      uint32 observationsTimestamp,
      uint32 expiresAt,
      int192 benchmarkPrice,
      int192 bid,
      int192 ask
    )
  {
    // Skip the fields not used for pricing: validFromTimestamp, nativeFee,
    // linkFee.
    (
      reportFeedId,
      ,
      observationsTimestamp,
      ,
      ,
      expiresAt,
      benchmarkPrice,
      bid,
      ask
    ) = abi.decode(
        verifiedReport,
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
