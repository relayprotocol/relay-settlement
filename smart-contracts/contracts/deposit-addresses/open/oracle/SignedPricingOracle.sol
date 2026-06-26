// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {Currency, IPricingOracle, Price} from "./IPricingOracle.sol";

/// @title SignedPricingOracle
/// @author Relay Protocol
/// @notice Pricing oracle that verifies USD prices signed by a single solver
///         pinned at construction. Interim implementation used until on-chain
///         price feeds (e.g. Chainlink-pull) are available; one instance is
///         deployed per solver and the deposit-address derivation pairs each
///         oracle with its solver via `derivationFields.solver`.
contract SignedPricingOracle is IPricingOracle, EIP712 {
  /// @notice The only address whose signatures are accepted as valid prices.
  /// @dev Pinning the signer at construction prevents a different allowlisted
  ///      solver from producing valid prices for a deposit address derived
  ///      with a different `derivationFields.solver`. `getUsdPrices` cannot
  ///      see `derivationFields.solver` (the IPricingOracle interface only
  ///      receives currencies and extraData), so this binding is the
  ///      on-chain check that the price was signed by the deposit address's
  ///      designated solver.
  address public immutable SOLVER;

  /// @notice EIP-712 typehash for `SignedPrice`. Excludes `signature`, which
  ///         is verification metadata, not part of the signed payload.
  bytes32 public constant SIGNED_PRICE_TYPEHASH =
    keccak256(
      "SignedPrice(string chainId,bytes currency,uint256 usdPrice,uint8 usdPriceDecimals,uint8 currencyDecimals,uint256 expiration)"
    );

  /// @notice A USD price signed by `SOLVER`.
  /// @param chainId Identifier of the chain the priced currency lives on; must equal the corresponding `currencies[i].chainId`
  /// @param currency Opaque encoding of the priced currency; must equal the corresponding `currencies[i].currency`
  /// @param usdPrice USD price of one whole unit of the currency, scaled by `10 ** usdPriceDecimals`
  /// @param usdPriceDecimals Fixed-point precision of `usdPrice`
  /// @param currencyDecimals Number of decimals the currency itself uses
  /// @param expiration Unix timestamp after which this price is no longer valid
  /// @param signature EIP-712 signature over the above fields by `SOLVER`
  struct SignedPrice {
    string chainId;
    bytes currency;
    uint256 usdPrice;
    uint8 usdPriceDecimals;
    uint8 currencyDecimals;
    uint256 expiration;
    bytes signature;
  }

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
  constructor(address solver) EIP712("SignedPricingOracle", "1") {
    SOLVER = solver;
  }

  /// @inheritdoc IPricingOracle
  /// @dev `extraData` must ABI-encode a `SignedPrice[]` of the same length as
  ///      `currencies`. Each entry is verified to (1) describe the currency
  ///      at the same index, (2) not be past `expiration`, and (3) carry a
  ///      valid EIP-712 signature from `SOLVER`. `SignatureChecker` supports
  ///      both EOAs and ERC-1271 contract signers.
  function getUsdPrices(
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external view returns (Price[] memory prices) {
    SignedPrice[] memory signed = abi.decode(extraData, (SignedPrice[]));

    uint256 length = currencies.length;
    if (signed.length != length) {
      revert PriceCountMismatch(length, signed.length);
    }

    prices = new Price[](length);
    for (uint256 i; i < length; ++i) {
      SignedPrice memory s = signed[i];

      if (
        keccak256(bytes(s.chainId)) !=
          keccak256(bytes(currencies[i].chainId)) ||
        keccak256(s.currency) != keccak256(currencies[i].currency)
      ) {
        revert CurrencyMismatch(i);
      }

      if (block.timestamp > s.expiration) {
        revert PriceExpired(i, s.expiration);
      }

      bytes32 digest = _hashSignedPrice(s);
      if (!SignatureChecker.isValidSignatureNow(SOLVER, digest, s.signature)) {
        revert InvalidSignature(i);
      }

      prices[i] = Price({
        usdPrice: s.usdPrice,
        usdPriceDecimals: s.usdPriceDecimals,
        currencyDecimals: s.currencyDecimals,
        expiration: s.expiration
      });
    }
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
            price.expiration
          )
        )
      );
  }
}
