// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {SignedPricingOracle} from "../../contracts/deposit-addresses/open/oracle/SignedPricingOracle.sol";
import {Currency} from "../../contracts/deposit-addresses/open/oracle/IPricingOracle.sol";

/// @notice Shared fixture for SignedPricingOracle tests.
abstract contract SignedPricingOracleBase is BaseTest {
    address internal solver;
    uint256 internal solverPk;
    address internal anyone;
    uint256 internal anyonePk;
    SignedPricingOracle internal oracle;
    bytes32 internal domainSep;

    bytes32 internal constant SIGNED_PRICE_TYPEHASH =
        keccak256(
            "SignedPrice(string chainId,bytes currency,uint256 usdPrice,uint8 usdPriceDecimals,uint8 currencyDecimals,uint256 expiration)"
        );

    function setUp() public virtual override {
        super.setUp();
        (solver, solverPk) = makeAddrAndKey("solver");
        (anyone, anyonePk) = makeAddrAndKey("anyone");

        oracle = new SignedPricingOracle(solver);
        domainSep = Eip712.domainSeparator(
            "SignedPricingOracle",
            "1",
            block.chainid,
            address(oracle)
        );
    }

    function _signedPrice(
        uint256 pk,
        string memory chainId,
        bytes memory currency,
        uint256 usdPrice,
        uint8 usdPriceDecimals,
        uint8 currencyDecimals,
        uint256 expiration
    ) internal view returns (SignedPricingOracle.SignedPrice memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SIGNED_PRICE_TYPEHASH,
                keccak256(bytes(chainId)),
                keccak256(currency),
                usdPrice,
                usdPriceDecimals,
                currencyDecimals,
                expiration
            )
        );
        bytes memory sig = Eip712.sign(pk, domainSep, structHash);
        return
            SignedPricingOracle.SignedPrice({
                chainId: chainId,
                currency: currency,
                usdPrice: usdPrice,
                usdPriceDecimals: usdPriceDecimals,
                currencyDecimals: currencyDecimals,
                expiration: expiration,
                signature: sig
            });
    }

    function _encode(
        SignedPricingOracle.SignedPrice[] memory items
    ) internal pure returns (bytes memory) {
        return abi.encode(items);
    }

    function _currency(
        string memory chainId,
        bytes memory addr
    ) internal pure returns (Currency memory) {
        return Currency({chainId: chainId, currency: addr});
    }
}
