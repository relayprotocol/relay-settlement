// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeedAdapter} from "../RelayPriceOracle.sol";

/// @title MockPriceFeedAdapter
/// @author Relay Protocol
/// @notice Test helper that decodes ABI-encoded feed updates into price data.
contract MockPriceFeedAdapter is IPriceFeedAdapter {
  /// @notice Thrown when the decoded feed ID does not match the requested feed.
  /// @param expected Feed ID requested by the caller.
  /// @param actual Feed ID decoded from the update data.
  error FeedIdMismatch(bytes32 expected, bytes32 actual);

  /// @inheritdoc IPriceFeedAdapter
  function decodeAndVerify(
    bytes32 feedId,
    bytes calldata updateData
  )
    external
    pure
    returns (uint256 usdPrice, uint8 usdPriceDecimals, uint256 publishTime)
  {
    bytes32 actualFeedId;
    (actualFeedId, usdPrice, usdPriceDecimals, publishTime) = abi.decode(
      updateData,
      (bytes32, uint256, uint8, uint256)
    );

    if (actualFeedId != feedId) {
      revert FeedIdMismatch(feedId, actualFeedId);
    }
  }
}
