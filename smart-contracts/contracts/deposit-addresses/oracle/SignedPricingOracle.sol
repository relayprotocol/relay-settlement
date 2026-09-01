// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {RelayPriceOracle} from "../../RelayPriceOracle.sol";
import {Currency, IPricingOracle, Price} from "./IPricingOracle.sol";

/// @title SignedPricingOracle
/// @author Relay Protocol
/// @notice Pricing oracle that prefers prices from `RelayPriceOracle` and
///         verifies solver-signed USD prices when an on-chain price is unavailable.
///         One instance is deployed per solver and the deposit-address derivation
///         pairs each oracle with its solver via `derivationFields.solver`.
contract SignedPricingOracle is IPricingOracle, EIP712 {
  /// @notice The on-chain oracle queried before signed prices are considered.
  RelayPriceOracle public immutable RELAY_PRICE_ORACLE;

  /// @notice The only address whose signatures are accepted as valid prices.
  /// @dev Pinning the signer at construction prevents a different allowlisted
  ///      solver from producing valid prices for a deposit address derived
  ///      with a different `derivationFields.solver`. `resolveUsdPrices` cannot
  ///      see `derivationFields.solver` (the IPricingOracle interface only
  ///      receives currencies and extraData), so this binding is the
  ///      on-chain check that the price was signed by the deposit address's
  ///      designated solver.
  address public immutable SOLVER;

  /// @notice EIP-712 typehash for `SignedPrice`. Excludes `signature`, which
  ///         is verification metadata, not part of the signed payload.
  bytes32 public constant SIGNED_PRICE_TYPEHASH =
    keccak256(
      "SignedPrice(string chainId,bytes currency,uint256 usdPrice,uint8 usdPriceDecimals,uint8 currencyDecimals,uint256 publishTime,uint256 expiration)"
    );

  /// @notice A USD price signed by `SOLVER`.
  /// @param chainId Identifier of the chain the priced currency lives on; must equal the corresponding `currencies[i].chainId`
  /// @param currency Opaque encoding of the priced currency; must equal the corresponding `currencies[i].currency`
  /// @param usdPrice USD price of one whole unit of the currency, scaled by `10 ** usdPriceDecimals`
  /// @param usdPriceDecimals Fixed-point precision of `usdPrice`
  /// @param currencyDecimals Number of decimals the currency itself uses
  /// @param publishTime Unix timestamp when the price was published
  /// @param expiration Unix timestamp after which this price is no longer valid
  /// @param signature EIP-712 signature over the above fields by `SOLVER`
  struct SignedPrice {
    string chainId;
    bytes currency;
    uint256 usdPrice;
    uint8 usdPriceDecimals;
    uint8 currencyDecimals;
    uint256 publishTime;
    uint256 expiration;
    bytes signature;
  }

  /// @notice Emitted after all requested USD prices have been resolved.
  /// @param prices USD prices in the same order as the requested currencies
  event PricesResolved(Price[] prices);

  /// @notice Thrown when the number of signed prices decoded from `extraData`
  ///         does not match the number of currencies requested.
  /// @param currencyCount Number of currencies requested
  /// @param priceCount Number of signed prices decoded from `extraData`
  error PriceCountMismatch(uint256 currencyCount, uint256 priceCount);

  /// @notice Thrown when the (chainId, currency) embedded in a signed price
  ///         does not match the requested currency at the same index.
  /// @param index Position in the `currencies` array
  error CurrencyMismatch(uint256 index);

  /// @notice Thrown when a signed price is past its expiration timestamp.
  /// @param index Position in the `currencies` array
  /// @param expiration Expiration timestamp of the expired signed price
  error PriceExpired(uint256 index, uint256 expiration);

  /// @notice Thrown when a signed price's signature was not produced by `SOLVER`.
  /// @param index Position in the `currencies` array
  error InvalidSignature(uint256 index);

  /// @notice Deploys a pricing oracle hard-bound to `solver`.
  /// @param solver The only address whose signatures will be accepted
  /// @param relayPriceOracle The on-chain oracle to query before signed prices
  constructor(
    address solver,
    address relayPriceOracle
  ) EIP712("SignedPricingOracle", "1") {
    SOLVER = solver;
    RELAY_PRICE_ORACLE = RelayPriceOracle(relayPriceOracle);
  }

  /// @inheritdoc IPricingOracle
  /// @dev The full currency batch is first queried from `RELAY_PRICE_ORACLE`.
  ///      If that query reverts, `extraData` must ABI-encode a `SignedPrice[]`
  ///      with one entry per currency. Each fallback entry is verified to (1)
  ///      describe its corresponding currency, (2) not be past `expiration`,
  ///      and (3) carry a valid EIP-712 signature from `SOLVER`.
  ///      `SignatureChecker` supports both EOAs and ERC-1271 contract signers.
  function resolveUsdPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external returns (Price[] memory prices) {
    try RELAY_PRICE_ORACLE.resolveUsdPrices(currencies) returns (
      Price[] memory relayPrices
    ) {
      prices = relayPrices;
    } catch {
      SignedPrice[] memory signed = abi.decode(extraData, (SignedPrice[]));
      uint256 length = currencies.length;
      if (signed.length != length) {
        revert PriceCountMismatch(length, signed.length);
      }

      prices = new Price[](length);
      for (uint256 i; i < length; ++i) {
        prices[i] = _resolveSignedPrice(currencies[i], signed[i], i);
      }
    }
    emit PricesResolved(prices);
  }

  /// @notice Verifies and converts a signed fallback price.
  /// @param currency Currency requested at `index`
  /// @param signedPrice Signed fallback price to verify
  /// @param index Position in the original currencies array
  /// @return price Verified USD price
  function _resolveSignedPrice(
    Currency calldata currency,
    SignedPrice memory signedPrice,
    uint256 index
  ) internal view returns (Price memory price) {
    if (
      keccak256(bytes(signedPrice.chainId)) !=
        keccak256(bytes(currency.chainId)) ||
      keccak256(signedPrice.currency) != keccak256(currency.currency)
    ) {
      revert CurrencyMismatch(index);
    }

    if (block.timestamp > signedPrice.expiration) {
      revert PriceExpired(index, signedPrice.expiration);
    }

    bytes32 digest = _hashSignedPrice(signedPrice);
    if (
      !SignatureChecker.isValidSignatureNow(
        SOLVER,
        digest,
        signedPrice.signature
      )
    ) {
      revert InvalidSignature(index);
    }

    price = Price({
      usdPrice: signedPrice.usdPrice,
      usdPriceDecimals: signedPrice.usdPriceDecimals,
      currencyDecimals: signedPrice.currencyDecimals,
      publishTime: signedPrice.publishTime,
      expiration: signedPrice.expiration
    });
  }

  /// @notice Returns the EIP-712 digest a `SignedPrice` must carry a signature for.
  /// @dev Exposed so off-chain signers can produce a matching signature
  ///      deterministically without re-deriving the typehash.
  /// @param price The signed price whose digest to compute
  /// @return digest The EIP-712 typed-data digest
  function hashSignedPrice(
    SignedPrice calldata price
  ) external view returns (bytes32 digest) {
    return _hashSignedPrice(price);
  }

  /// @notice Computes the EIP-712 digest for `price`.
  /// @dev Internal helper used by both the external view and the verification path.
  /// @param price The signed price whose digest to compute
  /// @return digest The EIP-712 typed-data digest
  function _hashSignedPrice(
    SignedPrice memory price
  ) internal view returns (bytes32 digest) {
    return
      _hashTypedDataV4(
        keccak256(
          abi.encode(
            SIGNED_PRICE_TYPEHASH,
            keccak256(bytes(price.chainId)),
            keccak256(price.currency),
            price.usdPrice,
            price.usdPriceDecimals,
            price.currencyDecimals,
            price.publishTime,
            price.expiration
          )
        )
      );
  }
}
