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
///      schema is V3, its benchmark price is positive, its timestamps form a
///      coherent range, its observation time does not move backward, its
///      bid/ask band is coherent, and it has not passed its `expiresAt`.
///
///      Fees: `verify` routes a fee through Chainlink's `FeeManager` in
///      `feeToken`. This adapter assumes either a zero-fee config or a LINK-fee
///      config the adapter is pre-funded and pre-approved for. Native
///      (value-bearing) fees would require a `payable` path end-to-end and are
///      out of scope here.
///
///      Cache: the adapter keeps the decoded fields of the last verified
///      report per feed in `cachedReports`. Repeat calls with byte-identical
///      `updateData` skip the fee-paying `verify` call and reuse the cached
///      fields. The expiry and structural checks still run on every call -
///      a cache hit is as strict as a fresh verification.
contract ChainlinkDataStreamsAdapter is IPriceFeedAdapter {
  /// @notice Schema version carried in the high 2 bytes of a feed ID for V3
  ///         (Crypto Streams) reports.
  uint16 public constant REPORT_V3_SCHEMA = 0x0003;

  /// @notice Fixed-point precision of a Data Streams V3 benchmark price.
  uint8 public constant USD_PRICE_DECIMALS = 18;

  /// @notice Cached pricing fields of the last verified report for a feed.
  /// @dev Packs into 4 storage slots: `reportHash` (32), then
  ///      `benchmarkPrice`/`validFromTimestamp`/`observationsTimestamp`
  ///      (24+4+4), then `expiresAt`/`bid` (4+24), then `ask` (24).
  /// @param reportHash keccak256 of the raw `fullReport` bytes the entry was
  ///        decoded from. Matching it against the hash of the bytes currently
  ///        served by the precompile detects a cache hit.
  /// @param benchmarkPrice Benchmark (mid) price, scaled by `USD_PRICE_DECIMALS`.
  /// @param validFromTimestamp Timestamp from which the report is valid.
  /// @param observationsTimestamp Report's latest observation timestamp.
  /// @param expiresAt Timestamp after which the report is no longer valid.
  /// @param bid Best bid price, scaled by `USD_PRICE_DECIMALS`.
  /// @param ask Best ask price, scaled by `USD_PRICE_DECIMALS`.
  struct CachedReport {
    bytes32 reportHash;
    int192 benchmarkPrice;
    uint32 validFromTimestamp;
    uint32 observationsTimestamp;
    uint32 expiresAt;
    int192 bid;
    int192 ask;
  }

  /// @notice Last verified report per feed, keyed by feed ID.
  /// @dev One live entry per feed: a new report overwrites the previous entry.
  ///      Entries hold raw decoded report fields, so the time-based validity
  ///      checks run identically on cached and freshly verified data.
  mapping(bytes32 feedId => CachedReport report) public cachedReports;

  /// @notice Chainlink `VerifierProxy` that checks DON signatures on-chain.
  IVerifierProxy public immutable VERIFIER_PROXY;

  /// @notice Fee token passed to `VerifierProxy.verify` (LINK or native fee token).
  address public immutable FEE_TOKEN;

  /// @inheritdoc IPriceFeedAdapter
  address public immutable ORACLE;

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

  /// @notice Thrown when the report timestamps do not form a valid range.
  /// @param validFromTimestamp Timestamp from which the report is valid.
  /// @param observationsTimestamp Report's latest observation timestamp.
  /// @param expiresAt Timestamp after which the report is no longer valid.
  error InvalidReportTimeRange(
    uint32 validFromTimestamp,
    uint32 observationsTimestamp,
    uint32 expiresAt
  );

  /// @notice Thrown when a report is older than the latest accepted report.
  /// @param feedId Feed whose observation timestamp moved backward.
  /// @param observationsTimestamp Observation timestamp in the new report.
  /// @param latestObservationsTimestamp Latest accepted observation timestamp.
  error TimestampRollback(
    bytes32 feedId,
    uint32 observationsTimestamp,
    uint32 latestObservationsTimestamp
  );

  /// @notice Thrown when the report contains an invalid bid/ask band.
  /// @param benchmarkPrice Benchmark (mid) price decoded from the report.
  /// @param bid Bid price decoded from the report.
  /// @param ask Ask price decoded from the report.
  error InvalidBidAsk(int192 benchmarkPrice, int192 bid, int192 ask);

  /// @notice Thrown when the report has passed its expiration timestamp.
  /// @param expiresAt Report's expiration timestamp.
  /// @param blockTimestamp Current block timestamp.
  error ReportExpired(uint32 expiresAt, uint256 blockTimestamp);

  /// @notice Deploys the adapter bound to an oracle and Chainlink `VerifierProxy`.
  /// @param _oracle RelayPriceOracle authorized to request verification.
  /// @param verifierProxy Chainlink Data Streams `VerifierProxy` to verify against.
  /// @param feeToken Fee token forwarded to `verify` (LINK or native fee token).
  constructor(address _oracle, IVerifierProxy verifierProxy, address feeToken) {
    if (_oracle == address(0)) {
      revert InvalidOracle(_oracle);
    }
    if (address(verifierProxy) == address(0)) {
      revert InvalidVerifierProxy();
    }
    ORACLE = _oracle;
    VERIFIER_PROXY = verifierProxy;
    FEE_TOKEN = feeToken;
  }

  /// @notice Restricts report verification and cache writes to the bound oracle.
  modifier onlyOracle() {
    if (msg.sender != ORACLE) {
      revert UnauthorizedCaller(msg.sender);
    }
    _;
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
    onlyOracle
    returns (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    )
  {
    bytes32 reportHash = keccak256(updateData);
    CachedReport memory cached = cachedReports[feedId];

    if (cached.reportHash != reportHash) {
      cached = _verifyAndCache(feedId, updateData, reportHash);
    }

    _validateReport(feedId, cached);

    // The DON-verified report carries the consensus benchmark (mid) price plus
    // the bid/ask band; surface all three so consumers can use the liquidity
    // distribution, not just the mid. A `(0, 0)` band means unavailable. Any
    // other band is validated as positive and ordered around the benchmark.
    usdPrice = uint256(uint192(cached.benchmarkPrice));
    if (cached.bid != 0) {
      bid = uint256(uint192(cached.bid));
      ask = uint256(uint192(cached.ask));
    }
    usdPriceDecimals = USD_PRICE_DECIMALS;
    publishTime = cached.observationsTimestamp;
  }

  /// @notice Verifies a report on-chain and caches its decoded pricing fields.
  /// @param feedId Feed the report must belong to.
  /// @param updateData Raw `fullReport` envelope to verify.
  /// @param reportHash keccak256 of `updateData`, stored as the cache identity.
  /// @return entry The cached entry written for `feedId`.
  function _verifyAndCache(
    bytes32 feedId,
    bytes calldata updateData,
    bytes32 reportHash
  ) private returns (CachedReport memory entry) {
    // On-chain DON-signature verification. `verify` reverts unless the report
    // is signed by the verifier's configured DON. It returns the decoded
    // report body, not the signed envelope.
    bytes memory verifiedReport = VERIFIER_PROXY.verify(
      updateData,
      abi.encode(FEE_TOKEN)
    );

    bytes32 reportFeedId;
    (reportFeedId, entry) = _decodeReport(verifiedReport, reportHash);

    // Checked before caching, so every entry under `feedId` is known to
    // belong to that feed. A revert later in `decodeAndVerify` rolls the
    // write back, so nothing invalid is ever cached.
    if (reportFeedId != feedId) {
      revert FeedIdMismatch(feedId, reportFeedId);
    }

    CachedReport memory latest = cachedReports[feedId];
    if (
      latest.reportHash != bytes32(0) &&
      entry.observationsTimestamp < latest.observationsTimestamp
    ) {
      revert TimestampRollback(
        feedId,
        entry.observationsTimestamp,
        latest.observationsTimestamp
      );
    }

    cachedReports[feedId] = entry;
  }

  /// @notice Validates fields that must remain valid on fresh and cached paths.
  function _validateReport(
    bytes32 feedId,
    CachedReport memory report
  ) private view {
    uint16 schemaVersion = uint16(uint256(feedId) >> 240);
    if (schemaVersion != REPORT_V3_SCHEMA) {
      revert UnsupportedReportSchema(schemaVersion);
    }

    if (report.benchmarkPrice <= 0) {
      revert NonPositivePrice(report.benchmarkPrice);
    }

    if (
      report.validFromTimestamp > report.observationsTimestamp ||
      report.observationsTimestamp > report.expiresAt
    ) {
      revert InvalidReportTimeRange(
        report.validFromTimestamp,
        report.observationsTimestamp,
        report.expiresAt
      );
    }

    if (block.timestamp > report.expiresAt) {
      revert ReportExpired(report.expiresAt, block.timestamp);
    }

    bool unavailableBand = report.bid == 0 && report.ask == 0;
    if (
      !unavailableBand &&
      (report.bid <= 0 ||
        report.ask <= 0 ||
        report.bid > report.benchmarkPrice ||
        report.benchmarkPrice > report.ask)
    ) {
      revert InvalidBidAsk(report.benchmarkPrice, report.bid, report.ask);
    }
  }

  /// @notice Decodes a verified V3 report body, keeping its validation fields.
  /// @param verifiedReport Decoded `ReportDataV3` body returned by `verify`.
  /// @param reportHash keccak256 of the report's raw `fullReport` envelope.
  /// @return reportFeedId Feed ID declared in the report body.
  /// @return entry Decoded report fields with `reportHash` set.
  function _decodeReport(
    bytes memory verifiedReport,
    bytes32 reportHash
  ) private pure returns (bytes32 reportFeedId, CachedReport memory entry) {
    // Skip the fee fields, which do not affect price validation.
    (
      reportFeedId,
      entry.validFromTimestamp,
      entry.observationsTimestamp,
      ,
      ,
      entry.expiresAt,
      entry.benchmarkPrice,
      entry.bid,
      entry.ask
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
    entry.reportHash = reportHash;
  }
}
