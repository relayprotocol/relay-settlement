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
///      any number of assets under its one signature, and if an asset id
///      repeats, the last occurrence wins.
///
///      Fees: verification charges a native-wei fee. The adapter calls with
///      zero value and assumes a zero-fee config, so a non-zero fee makes
///      verification revert rather than silently degrade.
///
///      Cache: the decoded fields of the last verified payload per feed are
///      kept in `cachedReports`. Verifying a batch caches an entry for every
///      feed it contains, all keyed to the hash of the same raw bytes, so
///      sibling feeds verified against a byte-identical `updateData` skip the
///      fee-paying verification call. The feed id is an immutable hash of the
///      pair an entry was verified against, so a cache hit is as strict as a
///      fresh verification.
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

  /// @dev Nanoseconds per second, for converting payload timestamps to the
  ///      Unix-seconds `publishTime` expected by `RelayPriceOracle`.
  uint64 private constant NS_PER_SECOND = 1e9;

  /// @notice Cached pricing fields of the last verified payload for a feed.
  /// @dev Packs into 2 storage slots: `reportHash` (32), then
  ///      `quantizedValue`/`publishTime` (24+8).
  /// @param reportHash keccak256 of the raw payload bytes the entry was
  ///        decoded from. Matching it against the hash of the bytes currently
  ///        served by the precompile detects a cache hit.
  /// @param quantizedValue Price scaled by `USD_PRICE_DECIMALS`.
  /// @param publishTime Payload timestamp truncated to Unix seconds.
  struct CachedReport {
    bytes32 reportHash;
    int192 quantizedValue;
    uint64 publishTime;
  }

  /// @notice Last verified payload per feed, keyed by feed ID.
  /// @dev One live entry per feed. A new payload overwrites the previous
  ///      entry.
  mapping(bytes32 feedId => CachedReport report) public cachedReports;

  /// @notice Stork Fast verifier that checks payload signatures on-chain.
  IStorkFastVerifier public immutable STORK_FAST_VERIFIER;

  /// @notice Thrown when the verifier address is zero.
  error InvalidStorkFastVerifier();

  /// @notice Thrown when no asset in the payload hashes to the requested
  ///         feed id.
  /// @param feedId Feed ID requested by the caller.
  error FeedNotInPayload(bytes32 feedId);

  /// @notice Thrown when the quantized value is zero or negative.
  /// @param quantizedValue Non-positive value decoded from the payload.
  error NonPositivePrice(int192 quantizedValue);

  /// @notice Deploys the adapter bound to a Stork Fast verifier.
  /// @param storkFastVerifier Stork Fast verifier to verify payloads against.
  constructor(IStorkFastVerifier storkFastVerifier) {
    if (address(storkFastVerifier) == address(0)) {
      revert InvalidStorkFastVerifier();
    }
    STORK_FAST_VERIFIER = storkFastVerifier;
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

    if (cached.quantizedValue <= 0) {
      revert NonPositivePrice(cached.quantizedValue);
    }

    // Fast payloads carry no bid/ask band, so it is reported as unavailable
    // (`bid == ask == 0`).
    usdPrice = uint256(uint192(cached.quantizedValue));
    bid = 0;
    ask = 0;
    usdPriceDecimals = USD_PRICE_DECIMALS;
    publishTime = cached.publishTime;
  }

  /// @notice Verifies a payload on-chain and caches the decoded pricing
  ///         fields of every asset it contains.
  /// @param feedId Feed the payload must contain.
  /// @param updateData Raw `signed_ecdsa` payload to verify.
  /// @param reportHash keccak256 of `updateData`, stored as the cache identity.
  /// @return entry The cached entry written for `feedId`.
  function _verifyAndCache(
    bytes32 feedId,
    bytes calldata updateData,
    bytes32 reportHash
  ) private returns (CachedReport memory entry) {
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

    // Each feed id is the hash of the payload's own identifying pair, so the
    // binding needs no per-feed configuration. One verification warms the
    // cache for every feed in the batch, and a duplicated asset id resolves
    // to its last occurrence.
    bool found;
    for (uint256 i; i < assets.length; ++i) {
      CachedReport memory decoded = CachedReport({
        reportHash: reportHash,
        quantizedValue: assets[i].temporalNumericValue.quantizedValue,
        publishTime: assets[i].temporalNumericValue.timestampNs / NS_PER_SECOND
      });
      bytes32 assetFeedId = computeFeedId(taxonomyId, assets[i].assetID);
      // A revert later in `decodeAndVerify` rolls these writes back, so
      // nothing invalid is ever cached.
      cachedReports[assetFeedId] = decoded;
      if (assetFeedId == feedId) {
        entry = decoded;
        found = true;
      }
    }
    if (!found) {
      revert FeedNotInPayload(feedId);
    }
  }
}
