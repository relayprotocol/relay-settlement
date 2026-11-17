// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IStorkFastVerifier} from "../price-adapters/StorkFastAdapter.sol";

/// @title MockStorkFastVerifier
/// @author Relay Protocol
/// @notice Test helper that mimics Stork Fast's
///         `verifyAndDeserializeSignedECDSAPayload` by deserializing the
///         payload's assets, without checking the ECDSA signature or charging
///         a fee.
contract MockStorkFastVerifier is IStorkFastVerifier {
  /// @dev Byte offset of the assets array in a signed ECDSA payload:
  ///      65-byte signature + 2-byte taxonomy id + 8-byte timestamp.
  uint256 private constant ASSETS_OFFSET = 75;

  /// @dev Bytes per asset entry: 2-byte asset id + 16-byte quantized value.
  uint256 private constant ASSET_BYTES = 18;

  /// @dev Byte offset of the uint64 nanosecond timestamp in the payload.
  uint256 private constant TIMESTAMP_NS_OFFSET = 67;

  /// @notice Thrown when the payload is malformed, mirroring the real
  ///         verifier's error.
  error InvalidPayload();

  /// @inheritdoc IStorkFastVerifier
  function verifyAndDeserializeSignedECDSAPayload(
    bytes calldata payload
  ) external payable returns (IStorkFastVerifier.Asset[] memory assets) {
    if (
      payload.length < ASSETS_OFFSET ||
      (payload.length - ASSETS_OFFSET) % ASSET_BYTES != 0
    ) {
      revert InvalidPayload();
    }

    uint64 timestampNs = uint64(
      bytes8(payload[TIMESTAMP_NS_OFFSET:TIMESTAMP_NS_OFFSET + 8])
    );

    uint256 numAssets = (payload.length - ASSETS_OFFSET) / ASSET_BYTES;
    assets = new IStorkFastVerifier.Asset[](numAssets);

    for (uint256 i; i < numAssets; ++i) {
      uint256 offset = ASSETS_OFFSET + i * ASSET_BYTES;
      assets[i] = IStorkFastVerifier.Asset({
        assetID: uint16(bytes2(payload[offset:offset + 2])),
        temporalNumericValue: IStorkFastVerifier.TemporalNumericValue({
          timestampNs: timestampNs,
          quantizedValue: int192(
            int128(uint128(bytes16(payload[offset + 2:offset + ASSET_BYTES])))
          )
        })
      });
    }
  }
}
