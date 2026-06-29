// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  Currency,
  IPricingOracle,
  Price
} from "../deposit-addresses/open/oracle/IPricingOracle.sol";

/// @title MockPricingOracle
/// @author Relay Protocol
/// @notice Test helper that returns caller-controlled USD prices keyed by
/// `(chainId, currency)`. `extraData` is accepted but ignored.
contract MockPricingOracle is IPricingOracle {
  /// @notice Stored USD price per `(chainId, currency)` key.
  mapping(bytes32 key => Price price) public prices;

  /// @notice Sets the USD price returned for a given `(chainId, currency)`
  /// pair.
  /// @param chainId Identifier of the chain the currency lives on
  /// @param currency Opaque, VM-specific encoding of the currency
  /// @param usdPrice USD price of one whole unit of the currency, scaled by `10 ** usdPriceDecimals`
  /// @param usdPriceDecimals Fixed-point precision of `usdPrice`
  /// @param currencyDecimals Number of decimals the currency itself uses
  /// @param expiration Unix timestamp after which this price should no longer be used
  function setPrice(
    string calldata chainId,
    bytes calldata currency,
    uint256 usdPrice,
    uint8 usdPriceDecimals,
    uint8 currencyDecimals,
    uint256 expiration
  ) external {
    prices[_key(chainId, currency)] = Price({
      usdPrice: usdPrice,
      usdPriceDecimals: usdPriceDecimals,
      currencyDecimals: currencyDecimals,
      expiration: expiration
    });
  }

  /// @inheritdoc IPricingOracle
  function resolveUsdPrices(
    Currency[] calldata currencies,
    bytes calldata
  ) external view returns (Price[] memory result) {
    uint256 length = currencies.length;
    result = new Price[](length);
    unchecked {
      for (uint256 i = 0; i < length; ++i) {
        result[i] = prices[_key(currencies[i].chainId, currencies[i].currency)];
      }
    }
  }

  /// @notice Derives the storage key for a `(chainId, currency)` pair.
  /// @param chainId Identifier of the chain the currency lives on
  /// @param currency Opaque, VM-specific encoding of the currency
  /// @return key Storage key used by the `prices` mapping
  function _key(
    string calldata chainId,
    bytes calldata currency
  ) internal pure returns (bytes32 key) {
    key = keccak256(abi.encodePacked(chainId, currency));
  }
}
