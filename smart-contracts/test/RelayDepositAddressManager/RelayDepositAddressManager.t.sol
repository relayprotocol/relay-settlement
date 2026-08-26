// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {RelayDepositAddressManager} from "../../contracts/deposit-addresses/RelayDepositAddressManager.sol";
import {BasicPricingOracle} from "../../contracts/deposit-addresses/oracle/BasicPricingOracle.sol";
import {Currency, Price} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";
import {MockPricingOracle} from "../../contracts/mocks/MockPricingOracle.sol";

/// @notice Port of test/RelayDepositAddressManager/RelayDepositAddressManager.ts.
contract RelayDepositAddressManagerBase is BaseTest {
    bytes32 internal constant ORDER_ID = keccak256(bytes("order-1"));
    bytes32 internal constant OTHER_ORDER_ID = keccak256(bytes("order-2"));
    bytes internal constant EMPTY_EXTRA_DATA = "";
    uint256 internal constant NONCE = 0;
    uint256 internal constant PRICE_PUBLISH_TIME = 1_800_000_000;
    uint256 internal constant PRICE_EXPIRATION = 1_900_000_000;
    uint8 internal constant USD_PRICE_DECIMALS = 8;

    string internal constant INPUT_VM_TYPE = "evm";
    string internal constant INPUT_CHAIN_ID = "1";
    string internal constant OUTPUT_CHAIN_ID = "10";
    uint256 internal constant INPUT_AMOUNT = 1_000_000;
    uint256 internal constant PRICE_IMPACT_BPS = 50;
    uint256 internal constant SALT = 123;
    address internal constant SOLVER = address(0xbEEF);

    bytes internal inputCurrency;
    bytes internal outputCurrency;
    bytes internal depositorBytes;
    bytes internal outputRecipient;
    bytes internal refundRecipient;

    MockPricingOracle internal oracle;
    RelayDepositAddressManager internal manager;

    Price internal inputPrice;
    Price internal outputPrice;

    function setUp() public virtual override {
        super.setUp();
        oracle = new MockPricingOracle();
        manager = new RelayDepositAddressManager();

        inputCurrency = _repeated(0xaa, 20);
        outputCurrency = _repeated(0xbb, 20);
        depositorBytes = _repeated(0x11, 20);
        outputRecipient = _repeated(0x22, 20);
        refundRecipient = _repeated(0x33, 20);

        inputPrice = Price({
            usdPrice: 123_456,
            usdPriceDecimals: USD_PRICE_DECIMALS,
            currencyDecimals: 18,
            publishTime: PRICE_PUBLISH_TIME,
            expiration: PRICE_EXPIRATION
        });
        outputPrice = Price({
            usdPrice: 789_012,
            usdPriceDecimals: USD_PRICE_DECIMALS,
            currencyDecimals: 6,
            publishTime: PRICE_PUBLISH_TIME,
            expiration: PRICE_EXPIRATION
        });
    }

    function _input() internal view returns (RelayDepositAddressManager.Input memory) {
        return
            RelayDepositAddressManager.Input({
                vmType: INPUT_VM_TYPE,
                chainId: INPUT_CHAIN_ID,
                currency: inputCurrency,
                amount: INPUT_AMOUNT
            });
    }

    function _derivation(
        address pricingOracle
    ) internal view returns (RelayDepositAddressManager.DerivationFields memory) {
        return
            RelayDepositAddressManager.DerivationFields({
                inputVmType: INPUT_VM_TYPE,
                outputVmType: "evm",
                outputChainId: OUTPUT_CHAIN_ID,
                outputCurrency: outputCurrency,
                outputRecipient: outputRecipient,
                solver: SOLVER,
                pricingOracle: pricingOracle,
                depositor: depositorBytes,
                refundRecipient: refundRecipient,
                priceImpactBps: PRICE_IMPACT_BPS,
                salt: SALT
            });
    }

    function _inputCurrencyArr() internal view returns (Currency[] memory currencies) {
        currencies = new Currency[](1);
        currencies[0] = Currency({chainId: INPUT_CHAIN_ID, currency: inputCurrency});
    }

    function _bothCurrencies() internal view returns (Currency[] memory currencies) {
        currencies = new Currency[](2);
        currencies[0] = Currency({chainId: INPUT_CHAIN_ID, currency: inputCurrency});
        currencies[1] = Currency({chainId: OUTPUT_CHAIN_ID, currency: outputCurrency});
    }

    function _hashTrigger(
        RelayDepositAddressManager.Input memory input,
        RelayDepositAddressManager.DerivationFields memory derivationFields,
        bytes32 orderId,
        uint256 nonce,
        Currency[] memory currencies,
        Price[] memory prices,
        bytes memory extraData
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(input, derivationFields, orderId, nonce, currencies, prices, extraData)
            );
    }

    function _seedPrices() internal {
        oracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            inputPrice.usdPrice,
            inputPrice.usdPriceDecimals,
            inputPrice.currencyDecimals,
            inputPrice.publishTime,
            inputPrice.expiration
        );
        oracle.setPrice(
            OUTPUT_CHAIN_ID,
            outputCurrency,
            outputPrice.usdPrice,
            outputPrice.usdPriceDecimals,
            outputPrice.currencyDecimals,
            outputPrice.publishTime,
            outputPrice.expiration
        );
    }

    function _repeated(uint8 b, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = bytes1(b);
        }
    }

    function _zeroPrice() internal pure returns (Price memory) {
        return
            Price({
                usdPrice: 0,
                usdPriceDecimals: 0,
                currencyDecimals: 0,
                publishTime: 0,
                expiration: 0
            });
    }
}

contract RelayDepositAddressManagerTriggerTest is RelayDepositAddressManagerBase {
    function test_storesTheTriggerHashAndEmitsTriggered() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _bothCurrencies();
        Price[] memory prices = new Price[](2);
        prices[0] = inputPrice;
        prices[1] = outputPrice;
        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );

        vm.expectEmit(true, true, true, true, address(manager));
        emit RelayDepositAddressManager.Triggered(ORDER_ID, expectedHash);
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }

    function test_acceptsEmptyPriceQueriesArray() public {
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = new Currency[](0);
        Price[] memory prices = new Price[](0);
        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }

    function test_capturesOraclePriceAtTriggerTime() public {
        _seedPrices();

        Price memory updatedInputPrice = Price({
            usdPrice: inputPrice.usdPrice + 1,
            usdPriceDecimals: inputPrice.usdPriceDecimals,
            currencyDecimals: inputPrice.currencyDecimals,
            publishTime: inputPrice.publishTime,
            expiration: inputPrice.expiration
        });
        oracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            updatedInputPrice.usdPrice,
            updatedInputPrice.usdPriceDecimals,
            updatedInputPrice.currencyDecimals,
            updatedInputPrice.publishTime,
            updatedInputPrice.expiration
        );

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](1);
        prices[0] = updatedInputPrice;
        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }

    function test_queriesOracleReferencedByDerivationFieldsPricingOracle() public {
        MockPricingOracle altOracle = new MockPricingOracle();
        Price memory altInputPrice = Price({
            usdPrice: 999_999,
            usdPriceDecimals: 6,
            currencyDecimals: 18,
            publishTime: PRICE_PUBLISH_TIME + 1,
            expiration: PRICE_EXPIRATION + 1
        });
        altOracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            altInputPrice.usdPrice,
            altInputPrice.usdPriceDecimals,
            altInputPrice.currencyDecimals,
            altInputPrice.publishTime,
            altInputPrice.expiration
        );

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(altOracle));
        Currency[] memory currencies = _inputCurrencyArr();

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](1);
        prices[0] = altInputPrice;
        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }

    function test_usesPricesSuppliedThroughExtraDataByBasicPricingOracle() public {
        BasicPricingOracle basicOracle = new BasicPricingOracle();
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(basicOracle));
        Currency[] memory currencies = _bothCurrencies();
        Price[] memory prices = new Price[](2);
        prices[0] = inputPrice;
        prices[1] = outputPrice;
        bytes memory extraData = abi.encode(prices);

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, extraData);

        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            extraData
        );
        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }

    function test_revertsWhenBasicPricingOracleReceivesWrongNumberOfPrices() public {
        BasicPricingOracle basicOracle = new BasicPricingOracle();
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(basicOracle));
        Currency[] memory currencies = _bothCurrencies();
        Price[] memory prices = new Price[](1);
        prices[0] = inputPrice;
        bytes memory extraData = abi.encode(prices);

        vm.expectRevert(
            abi.encodeWithSelector(
                BasicPricingOracle.PriceCountMismatch.selector,
                currencies.length,
                prices.length
            )
        );
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, extraData);
    }

    function test_bindsPriceExpirationIntoTheTriggerHash() public {
        oracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            inputPrice.usdPrice,
            inputPrice.usdPriceDecimals,
            inputPrice.currencyDecimals,
            inputPrice.publishTime,
            inputPrice.expiration
        );

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory matchingPrices = new Price[](1);
        matchingPrices[0] = inputPrice;
        Price[] memory mismatchedPrices = new Price[](1);
        mismatchedPrices[0] = Price({
            usdPrice: inputPrice.usdPrice,
            usdPriceDecimals: inputPrice.usdPriceDecimals,
            currencyDecimals: inputPrice.currencyDecimals,
            publishTime: inputPrice.publishTime,
            expiration: inputPrice.expiration + 1
        });

        bytes32 matchingHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            matchingPrices,
            EMPTY_EXTRA_DATA
        );
        bytes32 mismatchedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            mismatchedPrices,
            EMPTY_EXTRA_DATA
        );
        assertTrue(matchingHash != mismatchedHash);
        assertEq(manager.triggers(matchingHash), ORDER_ID);
        assertEq(manager.triggers(mismatchedHash), bytes32(0));
    }

    function test_bindsPricePublishTimeIntoTheTriggerHash() public {
        oracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            inputPrice.usdPrice,
            inputPrice.usdPriceDecimals,
            inputPrice.currencyDecimals,
            inputPrice.publishTime,
            inputPrice.expiration
        );

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory matchingPrices = new Price[](1);
        matchingPrices[0] = inputPrice;
        Price[] memory mismatchedPrices = new Price[](1);
        mismatchedPrices[0] = Price({
            usdPrice: inputPrice.usdPrice,
            usdPriceDecimals: inputPrice.usdPriceDecimals,
            currencyDecimals: inputPrice.currencyDecimals,
            publishTime: inputPrice.publishTime + 1,
            expiration: inputPrice.expiration
        });

        bytes32 matchingHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            matchingPrices,
            EMPTY_EXTRA_DATA
        );
        bytes32 mismatchedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            mismatchedPrices,
            EMPTY_EXTRA_DATA
        );
        assertTrue(matchingHash != mismatchedHash);
        assertEq(manager.triggers(matchingHash), ORDER_ID);
        assertEq(manager.triggers(mismatchedHash), bytes32(0));
    }

    function test_bindsUsdPriceDecimalsIntoTheTriggerHash() public {
        oracle.setPrice(
            INPUT_CHAIN_ID,
            inputCurrency,
            inputPrice.usdPrice,
            inputPrice.usdPriceDecimals,
            inputPrice.currencyDecimals,
            inputPrice.publishTime,
            inputPrice.expiration
        );

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory matchingPrices = new Price[](1);
        matchingPrices[0] = inputPrice;
        Price[] memory mismatchedPrices = new Price[](1);
        mismatchedPrices[0] = Price({
            usdPrice: inputPrice.usdPrice,
            usdPriceDecimals: 6,
            currencyDecimals: inputPrice.currencyDecimals,
            publishTime: inputPrice.publishTime,
            expiration: inputPrice.expiration
        });

        bytes32 matchingHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            matchingPrices,
            EMPTY_EXTRA_DATA
        );
        bytes32 mismatchedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            mismatchedPrices,
            EMPTY_EXTRA_DATA
        );
        assertTrue(matchingHash != mismatchedHash);
        assertEq(manager.triggers(matchingHash), ORDER_ID);
        assertEq(manager.triggers(mismatchedHash), bytes32(0));
    }

    function test_bindsSaltIntoTheTriggerHash() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory first = _derivation(address(oracle));
        RelayDepositAddressManager.DerivationFields memory second = _derivation(address(oracle));
        second.salt = first.salt + 1;
        Currency[] memory currencies = _inputCurrencyArr();

        manager.trigger(_input(), first, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);
        manager.trigger(_input(), second, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](1);
        prices[0] = inputPrice;
        bytes32 firstHash = _hashTrigger(
            _input(),
            first,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        bytes32 secondHash = _hashTrigger(
            _input(),
            second,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertTrue(firstHash != secondHash);
        assertEq(manager.triggers(firstHash), ORDER_ID);
        assertEq(manager.triggers(secondHash), ORDER_ID);
    }

    function test_bindsTheNonceIntoTheTriggerHash() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();

        uint256 firstNonce = 1;
        uint256 secondNonce = 2;

        manager.trigger(_input(), d, ORDER_ID, firstNonce, currencies, EMPTY_EXTRA_DATA);
        manager.trigger(_input(), d, ORDER_ID, secondNonce, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](1);
        prices[0] = inputPrice;
        bytes32 firstHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            firstNonce,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        bytes32 secondHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            secondNonce,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertTrue(firstHash != secondHash);
        assertEq(manager.triggers(firstHash), ORDER_ID);
        assertEq(manager.triggers(secondHash), ORDER_ID);
    }

    function test_bindsExtraDataIntoTheTriggerHash() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();
        bytes memory extraData = hex"deadbeefcafebabe";

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, extraData);

        Price[] memory prices = new Price[](1);
        prices[0] = inputPrice;
        bytes32 matchingHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            extraData
        );
        bytes32 mismatchedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertEq(manager.triggers(matchingHash), ORDER_ID);
        assertEq(manager.triggers(mismatchedHash), bytes32(0));
    }

    function test_revertsWithInvalidOrderIdWhenOrderIdIsZero() public {
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = new Currency[](0);

        vm.expectRevert(RelayDepositAddressManager.InvalidOrderId.selector);
        manager.trigger(_input(), d, bytes32(0), NONCE, currencies, EMPTY_EXTRA_DATA);
    }

    function test_revertsWithInputVmTypeMismatchWhenVmTypesDiffer() public {
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        RelayDepositAddressManager.Input memory mismatched = _input();
        mismatched.vmType = "svm";

        Currency[] memory currencies = new Currency[](0);

        vm.expectRevert(RelayDepositAddressManager.InputVmTypeMismatch.selector);
        manager.trigger(mismatched, d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);
    }

    function test_revertsWithAlreadyTriggeredWhenSameTriggerIsReplayed() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _bothCurrencies();

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](2);
        prices[0] = inputPrice;
        prices[1] = outputPrice;
        bytes32 triggerHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayDepositAddressManager.AlreadyTriggered.selector,
                triggerHash
            )
        );
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);
    }

    function test_allowsTwoDifferentOrderIdsToCoexist() public {
        _seedPrices();

        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _bothCurrencies();

        vm.recordLogs();
        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);
        manager.trigger(_input(), d, OTHER_ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Triggered(bytes32,bytes32)");
        uint256 count;
        bool sawFirst;
        bool sawSecond;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == sig) {
                ++count;
                if (logs[i].topics[1] == ORDER_ID) sawFirst = true;
                if (logs[i].topics[1] == OTHER_ORDER_ID) sawSecond = true;
            }
        }
        assertEq(count, 2);
        assertTrue(sawFirst);
        assertTrue(sawSecond);
    }

    function test_usesDefaultOraclePriceOfZeroForUnseededTokens() public {
        RelayDepositAddressManager.DerivationFields memory d = _derivation(address(oracle));
        Currency[] memory currencies = _inputCurrencyArr();

        manager.trigger(_input(), d, ORDER_ID, NONCE, currencies, EMPTY_EXTRA_DATA);

        Price[] memory prices = new Price[](1);
        prices[0] = _zeroPrice();
        bytes32 expectedHash = _hashTrigger(
            _input(),
            d,
            ORDER_ID,
            NONCE,
            currencies,
            prices,
            EMPTY_EXTRA_DATA
        );
        assertEq(manager.triggers(expectedHash), ORDER_ID);
    }
}
