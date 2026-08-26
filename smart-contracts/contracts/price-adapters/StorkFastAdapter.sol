// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeedAdapter} from "../RelayPriceOracle.sol";

/// @title IStorkFastVerifier
/// @author Relay Protocol
/// @notice Minimal interface for the Stork Fast verifier contract.
/// @dev Selector- and ABI-compatible with Stork's `StorkFast` v1.0.0 reference
///      contract (the `stork-fast-evm-sdk` npm package), so the adapter can be
///      pointed at a real `UpgradeableStorkFast` deployment without changes.
///      `verify` charges a native-wei fee and is payable, so it cannot be
///      reached from a `view`/`staticcall` context.
interface IStorkFastVerifier {
  /// @notice A timestamped value decoded from a Stork Fast payload.
  /// @param timestampNs Unix timestamp of the value in nanoseconds.
  /// @param quantizedValue Signed value scaled by 1e18.
  struct TemporalNumericValue {
    uint64 timestampNs;
    int192 quantizedValue;
  }

  /// @notice A single asset entry decoded from a Stork Fast payload batch.
  /// @param assetID Stork Fast asset id, unique within a taxonomy.
  /// @param temporalNumericValue The asset's timestamped value.
  struct Asset {
    uint16 assetID;
    TemporalNumericValue temporalNumericValue;
  }

  /// @notice Verifies a signed Stork Fast ECDSA payload and decodes its
  ///         assets. Reverts on an invalid signature.
  /// @param payload Raw `signed_ecdsa` payload as served by Stork Fast.
  /// @return assets Decoded asset values.
  function verifyAndDeserializeSignedECDSAPayload(
    bytes calldata payload
  ) external payable returns (Asset[] memory assets);
}

/// @title StorkFastAdapter
/// @author Relay Protocol
/// @notice `IPriceFeedAdapter` for Stork Fast signed ECDSA payloads. Verifies
///         the raw payload cached by the price precompile against a Stork Fast
///         verifier contract, then returns normalized USD price data to
///         `RelayPriceOracle`.
/// @dev Trust model: the verifier recovers the payload's single ECDSA
///      signature on-chain and reverts unless it matches the configured Stork
///      Fast signer. A payload identifies each asset only by
///      `(uint16 taxonomyId, uint16 assetId)`, so the feed id is defined as
///      `keccak256(abi.encodePacked(taxonomyId, assetId))`. The adapter
///      recomputes that hash for every asset in the payload and requires the
///      requested feed id to be among them, making the binding
///      self-certifying with no per-feed configuration. A payload may batch
///      any number of assets under its one signature. Duplicate asset IDs are
///      rejected.
///
///      Fees: verification charges a native-wei fee. The adapter calls with
///      zero value and assumes a zero-fee config, so a non-zero fee makes
///      verification revert rather than silently degrade.
///
///      Cache: `cachedReportHash` identifies the latest payload verified by
///      the adapter. A byte-identical payload skips the verifier even when a
///      different feed is requested. Only feeds actually requested by the
///      oracle keep packed `CachedReportValues`, avoiding writes for every
///      unused sibling feed in the batch. On a cache hit, the requested value
///      is decoded directly from the exact payload bytes whose hash was
///      previously signature-verified and fully validated.
///
///      Staleness: Fast payloads carry no expiry timestamp. Validity is
///      enforced by `RelayPriceOracle` via each route's `maxAgeSeconds`
///      window over the returned `publishTime`.
contract StorkFastAdapter is IPriceFeedAdapter {
  /// @notice Fixed-point precision of a Stork Fast quantized value.
  uint8 public constant USD_PRICE_DECIMALS = 18;

  /// @dev Byte offset of the uint16 taxonomy id in a signed ECDSA payload,
  ///      immediately after the 65-byte signature. The verifier drops the
  ///      taxonomy id from its decoded output, so the adapter reads it from
  ///      the raw payload bytes.
  uint256 private constant TAXONOMY_ID_OFFSET = 65;

  /// @dev Byte offset of the uint64 nanosecond timestamp in a signed payload.
  uint256 private constant TIMESTAMP_NS_OFFSET = 67;

  /// @dev Byte offset of the first asset in a signed payload.
  uint256 private constant ASSETS_OFFSET = 75;

  /// @dev Bytes per asset: 2-byte asset id and 16-byte quantized value.
  uint256 private constant ASSET_BYTES = 18;

  /// @dev Byte width of the asset id at the start of each asset entry.
  uint256 private constant ASSET_ID_BYTES = 2;

  /// @dev Nanoseconds per second, for converting payload timestamps to the
  ///      Unix-seconds `publishTime` expected by `RelayPriceOracle`.
  uint64 private constant NS_PER_SECOND = 1e9;

  /// @notice Latest accepted pricing fields for a consumed feed.
  /// @dev Packs into one storage slot: `quantizedValue` (24) and
  ///      `timestampNs` (8).
  /// @param quantizedValue Price scaled by `USD_PRICE_DECIMALS`.
  /// @param timestampNs Provider-signed Unix timestamp in nanoseconds.
  struct CachedReportValues {
    int192 quantizedValue;
    uint64 timestampNs;
  }

  /// @notice Hash of the latest payload verified by this adapter.
  bytes32 public cachedReportHash;

  /// @notice Latest accepted report values for each consumed feed.
  mapping(bytes32 feedId => CachedReportValues values)
    public cachedReportValues;

  /// @notice Stork Fast verifier that checks payload signatures on-chain.
  IStorkFastVerifier public immutable STORK_FAST_VERIFIER;

  /// @inheritdoc IPriceFeedAdapter
  address public immutable ORACLE;

  /// @notice Thrown when the verifier address is zero.
  error InvalidStorkFastVerifier();

  /// @notice Thrown when no asset in the payload hashes to the requested
  ///         feed id.
  /// @param feedId Feed ID requested by the caller.
  error FeedNotInPayload(bytes32 feedId);

  /// @notice Thrown when the quantized value is zero or negative.
  /// @param quantizedValue Non-positive value decoded from the payload.
  error NonPositivePrice(int192 quantizedValue);

  /// @notice Thrown when an asset ID appears more than once in a payload.
  /// @param assetId Duplicated Stork Fast asset ID.
  error DuplicateAssetId(uint16 assetId);

  /// @notice Thrown when a feed's nanosecond timestamp moves backwards.
  /// @param feedId Feed whose timestamp moved backwards.
  /// @param timestampNs Timestamp in the newly verified payload.
  /// @param latestTimestampNs Latest timestamp previously accepted for the feed.
  error TimestampRollback(
    bytes32 feedId,
    uint64 timestampNs,
    uint64 latestTimestampNs
  );

  /// @notice Thrown when the same feed and timestamp carry different prices.
  /// @param feedId Feed with contradictory observations.
  /// @param timestampNs Shared nanosecond timestamp of the observations.
  /// @param latestValue Price previously accepted at the timestamp.
  /// @param newValue Newly verified contradictory price.
  error ConflictingPriceAtTimestamp(
    bytes32 feedId,
    uint64 timestampNs,
    int192 latestValue,
    int192 newValue
  );

  /// @notice Deploys the adapter bound to an oracle and Stork Fast verifier.
  /// @param _oracle RelayPriceOracle authorized to request verification.
  /// @param storkFastVerifier Stork Fast verifier to verify payloads against.
  constructor(address _oracle, IStorkFastVerifier storkFastVerifier) {
    if (_oracle == address(0)) {
      revert InvalidOracle(_oracle);
    }
    if (address(storkFastVerifier) == address(0)) {
      revert InvalidStorkFastVerifier();
    }
    ORACLE = _oracle;
    STORK_FAST_VERIFIER = storkFastVerifier;
  }

  /// @notice Restricts report verification and cache writes to the bound oracle.
  modifier onlyOracle() {
    if (msg.sender != ORACLE) {
      revert UnauthorizedCaller(msg.sender);
    }
    _;
  }

  /// @notice Computes the feed id for a Stork Fast asset.
  /// @param taxonomyId Stork Fast taxonomy the asset id belongs to.
  /// @param assetId Stork Fast asset id within the taxonomy.
  /// @return feedId `keccak256(abi.encodePacked(taxonomyId, assetId))`.
  function computeFeedId(
    uint16 taxonomyId,
    uint16 assetId
  ) public pure returns (bytes32 feedId) {
    feedId = keccak256(abi.encodePacked(taxonomyId, assetId));
  }

  /// @inheritdoc IPriceFeedAdapter
  /// @dev `updateData` is a Stork Fast `signed_ecdsa` payload:
  ///      `[0:65] signature (r 32 | s 32 | v 1, v is 0/1)`,
  ///      `[65:67] taxonomyId (uint16)`, `[67:75] timestampNs (uint64)`,
  ///      `[75:..] assets[]`, 18 bytes each:
  ///      `assetId (uint16) | quantizedValue (int128)`. It is forwarded
  ///      verbatim to the verifier, which checks the signature and returns the
  ///      decoded assets.
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
    CachedReportValues memory values;

    if (cachedReportHash == reportHash) {
      values = _decodeCachedReportValues(feedId, updateData);
      _validateReportValues(feedId, values);
    } else {
      values = _verifyReport(feedId, updateData);
      cachedReportHash = reportHash;
    }

    if (values.quantizedValue <= 0) {
      revert NonPositivePrice(values.quantizedValue);
    }

    _storeReportValues(feedId, values);

    // Fast payloads carry no bid/ask band, so it is reported as unavailable
    // (`bid == ask == 0`).
    usdPrice = uint256(uint192(values.quantizedValue));
    bid = 0;
    ask = 0;
    usdPriceDecimals = USD_PRICE_DECIMALS;
    publishTime = values.timestampNs / NS_PER_SECOND;
  }

  /// @notice Verifies a payload and validates every decoded asset.
  /// @param feedId Feed the payload must contain.
  /// @param updateData Raw `signed_ecdsa` payload to verify.
  /// @return requestedValues Report values for `feedId`.
  function _verifyReport(
    bytes32 feedId,
    bytes calldata updateData
  ) private returns (CachedReportValues memory requestedValues) {
    // Reverts unless the payload is signed by the verifier's configured Stork
    // Fast signer. Called with zero value under the zero-fee assumption.
    IStorkFastVerifier.Asset[] memory assets = STORK_FAST_VERIFIER
      .verifyAndDeserializeSignedECDSAPayload(updateData);

    // The verifier drops the taxonomy id from its decoded output, so read it
    // from the raw payload. The verifier has already validated the payload's
    // length.
    uint16 taxonomyId = uint16(
      bytes2(updateData[TAXONOMY_ID_OFFSET:TAXONOMY_ID_OFFSET + 2])
    );

    requestedValues = _validateBatch(taxonomyId, assets, feedId);
  }

  /// @notice Rejects duplicate assets and validates the complete batch.
  /// @dev No state is written while iterating, so any invalid sibling rejects
  ///      the report atomically without partially advancing feed state.
  /// @return requestedValues Report values for `requestedFeedId`.
  function _validateBatch(
    uint16 taxonomyId,
    IStorkFastVerifier.Asset[] memory assets,
    bytes32 requestedFeedId
  ) private view returns (CachedReportValues memory requestedValues) {
    uint256[256] memory seenAssetIds;
    bool foundRequestedFeed;

    for (uint256 i; i < assets.length; ++i) {
      uint16 assetId = assets[i].assetID;
      uint256 wordIndex = uint256(assetId) >> 8;
      uint256 assetBit = uint256(1) << uint8(assetId);
      if ((seenAssetIds[wordIndex] & assetBit) != 0) {
        revert DuplicateAssetId(assetId);
      }
      seenAssetIds[wordIndex] |= assetBit;

      bytes32 assetFeedId = computeFeedId(taxonomyId, assetId);
      CachedReportValues memory values = CachedReportValues({
        quantizedValue: assets[i].temporalNumericValue.quantizedValue,
        timestampNs: assets[i].temporalNumericValue.timestampNs
      });
      _validateReportValues(assetFeedId, values);

      if (assetFeedId == requestedFeedId) {
        requestedValues = values;
        foundRequestedFeed = true;
      }
    }

    if (!foundRequestedFeed) {
      revert FeedNotInPayload(requestedFeedId);
    }
  }

  /// @notice Decodes requested values from a cached verified payload.
  /// @return values Report values for `requestedFeedId`.
  function _decodeCachedReportValues(
    bytes32 requestedFeedId,
    bytes calldata updateData
  ) private pure returns (CachedReportValues memory values) {
    uint16 taxonomyId = uint16(
      bytes2(updateData[TAXONOMY_ID_OFFSET:TAXONOMY_ID_OFFSET + 2])
    );
    uint64 timestampNs = uint64(
      bytes8(updateData[TIMESTAMP_NS_OFFSET:TIMESTAMP_NS_OFFSET + 8])
    );

    uint256 numAssets = (updateData.length - ASSETS_OFFSET) / ASSET_BYTES;
    for (uint256 i; i < numAssets; ++i) {
      uint256 offset = ASSETS_OFFSET + i * ASSET_BYTES;
      uint16 assetId = uint16(bytes2(updateData[offset:offset + 2]));
      if (computeFeedId(taxonomyId, assetId) == requestedFeedId) {
        int128 quantizedValue = int128(
          uint128(
            bytes16(updateData[offset + ASSET_ID_BYTES:offset + ASSET_BYTES])
          )
        );
        return
          CachedReportValues({
            quantizedValue: int192(quantizedValue),
            timestampNs: timestampNs
          });
      }
    }

    revert FeedNotInPayload(requestedFeedId);
  }

  /// @notice Validates report values against the feed's accepted state.
  function _validateReportValues(
    bytes32 feedId,
    CachedReportValues memory values
  ) private view {
    CachedReportValues memory cached = cachedReportValues[feedId];
    if (cached.timestampNs == 0) {
      return;
    }
    if (values.timestampNs < cached.timestampNs) {
      revert TimestampRollback(feedId, values.timestampNs, cached.timestampNs);
    }
    if (
      values.timestampNs == cached.timestampNs &&
      values.quantizedValue != cached.quantizedValue
    ) {
      revert ConflictingPriceAtTimestamp(
        feedId,
        values.timestampNs,
        cached.quantizedValue,
        values.quantizedValue
      );
    }
  }

  /// @notice Advances a consumed feed without rewriting identical state.
  function _storeReportValues(
    bytes32 feedId,
    CachedReportValues memory values
  ) private {
    if (values.timestampNs > cachedReportValues[feedId].timestampNs) {
      cachedReportValues[feedId] = values;
    }
  }
}
