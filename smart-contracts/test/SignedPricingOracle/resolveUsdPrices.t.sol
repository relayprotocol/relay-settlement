// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignedPricingOracleBase} from "./SignedPricingOracleBase.sol";
import {SignedPricingOracle} from "../../contracts/deposit-addresses/oracle/SignedPricingOracle.sol";
import {Currency, Price} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";

/// @notice Port of test/SignedPricingOracle/getUsdPrices.ts.
contract SignedPricingOracleResolveUsdPricesTest is SignedPricingOracleBase {
    string internal constant INPUT_CHAIN = "1";
    string internal constant OUTPUT_CHAIN = "10";
    bytes internal constant INPUT_CURRENCY_BYTES =
        hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes internal constant OUTPUT_CURRENCY_BYTES =
        hex"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    uint256 internal constant FUTURE_EXPIRATION = 9_999_999_999;
    uint256 internal constant PUBLISH_TIME = 1_700_000_000;

    uint256 internal constant INPUT_USD_PRICE = 100_000_000;
    uint8 internal constant INPUT_USD_DECIMALS = 8;
    uint8 internal constant INPUT_CURRENCY_DECIMALS = 18;

    uint256 internal constant OUTPUT_USD_PRICE = 200_000_000;
    uint8 internal constant OUTPUT_USD_DECIMALS = 8;
    uint8 internal constant OUTPUT_CURRENCY_DECIMALS = 6;

    function setUp() public override {
        super.setUp();
        // SignedPricingOracle uses block.timestamp; warp to a realistic value
        // so test expirations sit in the future.
        vm.warp(1_700_000_000);
    }

    function _inputCurrency() internal pure returns (Currency memory) {
        return _currency(INPUT_CHAIN, INPUT_CURRENCY_BYTES);
    }

    function _outputCurrency() internal pure returns (Currency memory) {
        return _currency(OUTPUT_CHAIN, OUTPUT_CURRENCY_BYTES);
    }

    function _signInput()
        internal
        view
        returns (SignedPricingOracle.SignedPrice memory)
    {
        return
            _signedPrice(
                solverPk,
                INPUT_CHAIN,
                INPUT_CURRENCY_BYTES,
                INPUT_USD_PRICE,
                INPUT_USD_DECIMALS,
                INPUT_CURRENCY_DECIMALS,
                PUBLISH_TIME,
                FUTURE_EXPIRATION
            );
    }

    function _signOutput()
        internal
        view
        returns (SignedPricingOracle.SignedPrice memory)
    {
        return
            _signedPrice(
                solverPk,
                OUTPUT_CHAIN,
                OUTPUT_CURRENCY_BYTES,
                OUTPUT_USD_PRICE,
                OUTPUT_USD_DECIMALS,
                OUTPUT_CURRENCY_DECIMALS,
                PUBLISH_TIME,
                FUTURE_EXPIRATION
            );
    }

    function test_returnsPricesForValidSignedAttestations() public view {
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](2);
        signed[0] = _signInput();
        signed[1] = _signOutput();

        Currency[] memory currencies = new Currency[](2);
        currencies[0] = _inputCurrency();
        currencies[1] = _outputCurrency();

        Price[] memory prices = oracle.resolveUsdPrices(currencies, _encode(signed));
        assertEq(prices.length, 2);
        assertEq(prices[0].usdPrice, INPUT_USD_PRICE);
        assertEq(prices[0].usdPriceDecimals, INPUT_USD_DECIMALS);
        assertEq(prices[0].currencyDecimals, INPUT_CURRENCY_DECIMALS);
        assertEq(prices[0].publishTime, PUBLISH_TIME);
        assertEq(prices[0].expiration, FUTURE_EXPIRATION);
        assertEq(prices[1].usdPrice, OUTPUT_USD_PRICE);
        assertEq(prices[1].usdPriceDecimals, OUTPUT_USD_DECIMALS);
        assertEq(prices[1].currencyDecimals, OUTPUT_CURRENCY_DECIMALS);
        assertEq(prices[1].publishTime, PUBLISH_TIME);
        assertEq(prices[1].expiration, FUTURE_EXPIRATION);
    }

    function test_exposesBoundSolverOnContract() public view {
        assertEq(oracle.SOLVER(), solver);
    }

    function test_returnsDigestFromHashSignedPriceMatchingOffChainSigner()
        public
        view
    {
        SignedPricingOracle.SignedPrice memory s = _signInput();
        bytes32 digest = oracle.hashSignedPrice(s);
        assertTrue(digest != bytes32(0));
    }

    function test_revertsWithPriceCountMismatch() public {
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = _signInput();

        Currency[] memory currencies = new Currency[](2);
        currencies[0] = _inputCurrency();
        currencies[1] = _outputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.PriceCountMismatch.selector,
                uint256(2),
                uint256(1)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithCurrencyMismatchWhenEmbeddedChainIdDiffers()
        public
    {
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = _signedPrice(
            solverPk,
            "137",
            INPUT_CURRENCY_BYTES,
            INPUT_USD_PRICE,
            INPUT_USD_DECIMALS,
            INPUT_CURRENCY_DECIMALS,
            PUBLISH_TIME,
            FUTURE_EXPIRATION
        );

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.CurrencyMismatch.selector,
                uint256(0)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithCurrencyMismatchWhenEmbeddedCurrencyDiffers()
        public
    {
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = _signedPrice(
            solverPk,
            INPUT_CHAIN,
            hex"cccccccccccccccccccccccccccccccccccccccc",
            INPUT_USD_PRICE,
            INPUT_USD_DECIMALS,
            INPUT_CURRENCY_DECIMALS,
            PUBLISH_TIME,
            FUTURE_EXPIRATION
        );

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.CurrencyMismatch.selector,
                uint256(0)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithPriceExpiredWhenAttestationIsPastExpiration()
        public
    {
        uint256 expiration = block.timestamp + 100;
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = _signedPrice(
            solverPk,
            INPUT_CHAIN,
            INPUT_CURRENCY_BYTES,
            INPUT_USD_PRICE,
            INPUT_USD_DECIMALS,
            INPUT_CURRENCY_DECIMALS,
            PUBLISH_TIME,
            expiration
        );
        vm.warp(expiration + 1);

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.PriceExpired.selector,
                uint256(0),
                expiration
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithInvalidSignatureWhenSignedByNonSolver() public {
        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = _signedPrice(
            anyonePk,
            INPUT_CHAIN,
            INPUT_CURRENCY_BYTES,
            INPUT_USD_PRICE,
            INPUT_USD_DECIMALS,
            INPUT_CURRENCY_DECIMALS,
            PUBLISH_TIME,
            FUTURE_EXPIRATION
        );

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.InvalidSignature.selector,
                uint256(0)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithInvalidSignatureWhenUsdPriceTampered() public {
        SignedPricingOracle.SignedPrice memory s = _signInput();
        s.usdPrice = INPUT_USD_PRICE + 1; // tamper after signing

        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = s;

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.InvalidSignature.selector,
                uint256(0)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }

    function test_revertsWithInvalidSignatureWhenSignatureIsEmpty() public {
        SignedPricingOracle.SignedPrice memory tampered = SignedPricingOracle
            .SignedPrice({
                chainId: INPUT_CHAIN,
                currency: INPUT_CURRENCY_BYTES,
                usdPrice: INPUT_USD_PRICE,
                usdPriceDecimals: INPUT_USD_DECIMALS,
                currencyDecimals: INPUT_CURRENCY_DECIMALS,
                publishTime: PUBLISH_TIME,
                expiration: FUTURE_EXPIRATION,
                signature: ""
            });

        SignedPricingOracle.SignedPrice[]
            memory signed = new SignedPricingOracle.SignedPrice[](1);
        signed[0] = tampered;

        Currency[] memory currencies = new Currency[](1);
        currencies[0] = _inputCurrency();

        vm.expectRevert(
            abi.encodeWithSelector(
                SignedPricingOracle.InvalidSignature.selector,
                uint256(0)
            )
        );
        oracle.resolveUsdPrices(currencies, _encode(signed));
    }
}
