// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceFeedAdapter} from "../RelayPriceOracle.sol";

/// @title MockPriceFeedAdapter
/// @author Relay Protocol
/// @notice Test helper that decodes ABI-encoded feed updates into price data.
contract MockPriceFeedAdapter is IPriceFeedAdapter {
  /// @inheritdoc IPriceFeedAdapter
  address public immutable ORACLE;

  /// @notice Thrown when the decoded feed ID does not match the requested feed.
  /// @param expected Feed ID requested by the caller.
  /// @param actual Feed ID decoded from the update data.
  error FeedIdMismatch(bytes32 expected, bytes32 actual);

  /// @notice Deploys the mock bound to an oracle.
  constructor(address _oracle) {
    if (_oracle == address(0)) {
      revert InvalidOracle(_oracle);
    }
    ORACLE = _oracle;
  }

  /// @notice Restricts mock decoding to the bound oracle.
  modifier onlyOracle() {
    if (msg.sender != ORACLE) {
      revert UnauthorizedCaller(msg.sender);
    }
    _;
  }

  /// @inheritdoc IPriceFeedAdapter
  /// @dev This mock has no bid/ask spread, so it returns `bid = ask = 0`.
  function decodeAndVerify(
    bytes32 feedId,
    bytes calldata updateData
  )
    external
    view
    onlyOracle
    returns (
      uint256 usdPrice,
      uint256 bid,
      uint256 ask,
      uint8 usdPriceDecimals,
      uint256 publishTime
    )
  {
    bytes32 actualFeedId;
    (actualFeedId, usdPrice, usdPriceDecimals, publishTime) = abi.decode(
      updateData,
      (bytes32, uint256, uint8, uint256)
    );

    if (actualFeedId != feedId) {
      revert FeedIdMismatch(feedId, actualFeedId);
    }

    // No bid/ask spread: `bid` and `ask` default to 0 (unavailable).
  }
}
