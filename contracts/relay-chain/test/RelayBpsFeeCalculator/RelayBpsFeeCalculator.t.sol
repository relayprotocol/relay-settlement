// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";

import {Price} from "../../contracts/deposit-addresses/oracle/IPricingOracle.sol";
import {RelayBpsFeeCalculator} from "../../contracts/fee-calculators/RelayBpsFeeCalculator.sol";
import {DeployRelayBpsFeeCalculator} from "../../script/DeployRelayBpsFeeCalculator.s.sol";

contract MockRelayBpsFeePriceOracle {
  mapping(uint256 => Price) internal prices;

  function setPrice(uint256 tokenId, Price memory price) external {
    prices[tokenId] = price;
  }

  function resolveUsdPrice(
    uint256 tokenId
  ) external view returns (Price memory price) {
    return prices[tokenId];
  }
}

contract RelayBpsFeeCalculatorTest is BaseTest {
  MockRelayBpsFeePriceOracle internal priceOracle;
  RelayBpsFeeCalculator internal calculator;

  uint256 internal constant TOKEN_ID = 1;
  uint256 internal constant FEE_CURRENCY = 2;
  uint256 internal constant FEE_BPS = 1e16; // 1%

  address internal feeRecipient;
  address internal feePayer;

  function setUp() public override {
    super.setUp();
    vm.warp(1_700_000_000);

    feeRecipient = makeAddr("feeRecipient");
    feePayer = makeAddr("feePayer");

    priceOracle = new MockRelayBpsFeePriceOracle();
    calculator = new RelayBpsFeeCalculator(address(priceOracle));

    _setUsdPrice(TOKEN_ID, 2e8, 8, 6); // token = $2.00, 6 decimals
    _setUsdPrice(FEE_CURRENCY, 5e7, 8, 6); // fee currency = $0.50, 6 decimals
  }

  function _setUsdPrice(
    uint256 tokenId,
    uint256 usdPrice,
    uint8 usdPriceDecimals,
    uint8 currencyDecimals
  ) internal {
    priceOracle.setPrice(
      tokenId,
      Price({
        usdPrice: usdPrice,
        usdPriceDecimals: usdPriceDecimals,
        currencyDecimals: currencyDecimals,
        publishTime: block.timestamp,
        expiration: block.timestamp + 1 days
      })
    );
  }

  function _feeData(
    uint256 feeBps,
    uint256 feeCurrency,
    address recipient,
    address payer
  ) internal pure returns (bytes memory) {
    return
      _feeDataWithMax(feeBps, feeCurrency, type(uint256).max, recipient, payer);
  }

  function _feeDataWithMax(
    uint256 feeBps,
    uint256 feeCurrency,
    uint256 maxFeeAmount,
    address recipient,
    address payer
  ) internal pure returns (bytes memory) {
    return abi.encode(feeCurrency, feeBps, maxFeeAmount, recipient, payer);
  }

  function test_calculateFeeConvertsThroughUsd() public {
    (
      uint256 feeCurrency,
      uint256 feeAmount,
      address recipient,
      address payer
    ) = calculator.calculateFee(
        TOKEN_ID,
        100e6,
        _feeData(FEE_BPS, FEE_CURRENCY, feeRecipient, feePayer)
      );

    // 100 tokens * $2 = $200; 1% fee = $2; $2 / $0.50 = 4 fee tokens.
    assertEq(feeCurrency, FEE_CURRENCY);
    assertEq(feeAmount, 4e6);
    assertEq(recipient, feeRecipient);
    assertEq(payer, feePayer);
  }

  function test_calculateFeeSameCurrencyMatchesBps() public {
    (
      uint256 feeCurrency,
      uint256 feeAmount,
      address recipient,
      address payer
    ) = calculator.calculateFee(
        TOKEN_ID,
        100e6,
        _feeData(FEE_BPS, TOKEN_ID, feeRecipient, feePayer)
      );

    assertEq(feeCurrency, TOKEN_ID);
    assertEq(feeAmount, 1e6);
    assertEq(recipient, feeRecipient);
    assertEq(payer, feePayer);
  }

  function test_calculateFeeHandlesUsdDecimalNormalization() public {
    _setUsdPrice(TOKEN_ID, 2e6, 6, 6);
    _setUsdPrice(FEE_CURRENCY, 5e17, 18, 6);

    (, uint256 feeAmount, , ) = calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeData(FEE_BPS, FEE_CURRENCY, feeRecipient, feePayer)
    );

    assertEq(feeAmount, 4e6);
  }

  function test_calculateFeeAllowsZeroRecipientAndPayerWhenFeeIsZero() public {
    (
      uint256 feeCurrency,
      uint256 feeAmount,
      address recipient,
      address payer
    ) = calculator.calculateFee(
        TOKEN_ID,
        100e6,
        _feeData(0, FEE_CURRENCY, address(0), address(0))
      );

    assertEq(feeCurrency, FEE_CURRENCY);
    assertEq(feeAmount, 0);
    assertEq(recipient, address(0));
    assertEq(payer, address(0));
  }

  function test_allowsFeeAtExactMax() public {
    (, uint256 feeAmount, , ) = calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeDataWithMax(FEE_BPS, FEE_CURRENCY, 4e6, feeRecipient, feePayer)
    );

    assertEq(feeAmount, 4e6);
  }

  function test_revertsWhenFeeExceedsMax() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayBpsFeeCalculator.FeeExceedsMax.selector,
        4e6,
        4e6 - 1
      )
    );
    calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeDataWithMax(FEE_BPS, FEE_CURRENCY, 4e6 - 1, feeRecipient, feePayer)
    );
  }

  function test_revertsOnZeroMaxWithNonZeroFee() public {
    // Fail-closed: no special zero semantics — an unset cap rejects any non-zero fee.
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayBpsFeeCalculator.FeeExceedsMax.selector,
        4e6,
        0
      )
    );
    calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeDataWithMax(FEE_BPS, FEE_CURRENCY, 0, feeRecipient, feePayer)
    );
  }

  function test_revertsInvalidFeeBps() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayBpsFeeCalculator.InvalidFeeBps.selector,
        1e18 + 1
      )
    );
    calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeData(1e18 + 1, FEE_CURRENCY, feeRecipient, feePayer)
    );
  }

  function test_revertsInvalidFeeRecipientWhenFeeNonZero() public {
    vm.expectRevert(RelayBpsFeeCalculator.InvalidFeeRecipient.selector);
    calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeData(FEE_BPS, FEE_CURRENCY, address(0), feePayer)
    );
  }

  function test_revertsInvalidFeePayerWhenFeeNonZero() public {
    vm.expectRevert(RelayBpsFeeCalculator.InvalidFeePayer.selector);
    calculator.calculateFee(
      TOKEN_ID,
      100e6,
      _feeData(FEE_BPS, FEE_CURRENCY, feeRecipient, address(0))
    );
  }

  function test_constructorRejectsZeroPriceOracle() public {
    vm.expectRevert(RelayBpsFeeCalculator.ZeroAddress.selector);
    new RelayBpsFeeCalculator(address(0));
  }

  function test_deployScriptUsesPriceOracleEnv() public {
    (address deployer, uint256 deployerPk) = makeAddrAndKey("deployer");
    vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerPk));
    vm.setEnv("PRICE_ORACLE", vm.toString(address(priceOracle)));

    RelayBpsFeeCalculator deployed = new DeployRelayBpsFeeCalculator().run();

    assertEq(address(deployed.PRICE_ORACLE()), address(priceOracle));
    assertTrue(deployer != address(0));
  }
}
