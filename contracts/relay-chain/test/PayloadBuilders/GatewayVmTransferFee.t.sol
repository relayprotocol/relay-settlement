// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {GatewayVmPayloadBuilderBase} from "./GatewayVmPayloadBuilder.t.sol";
import {Config} from "../../contracts/Config.sol";
import {
  GatewayVmPayloadBuilder,
  GatewayVmPayload
} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {WithdrawRequest} from "../../contracts/RelayAllocator.sol";

contract GatewayVmTransferFeeTest is GatewayVmPayloadBuilderBase {
  function test_defaultsToHalfBasisPoint() public view {
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE + 50);
  }

  function test_zeroSourceOverrideOnlyRequiresFixedGasFee() public {
    _setSourceFee(0);
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE);
  }

  function test_usesSourceOverride() public {
    _setSourceFee(100);
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE + 100);
  }

  function test_ignoresOverridesForOtherSources() public {
    _setConfig(builder.getSourceTransferFeeKey("other-gateway"), bytes32(0));
    _setConfig(builder.getSourceTransferFeeKey(EVM_SUBCHAIN_ID), bytes32(0));
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE + 50);
  }

  function test_sameDomainSkipsPercentageOverrides() public {
    _setConfig(
      builder.getCircleDomainKey(EVM_SUBCHAIN_ID),
      bytes32(uint256(SOURCE_DOMAIN))
    );
    _setSourceFee(100);
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE);
  }

  function test_rejectsSourceRateAboveOneHundredPercent() public {
    _setSourceFee(1_000_001);
    _expectInvalidRate(1_000_001);
  }

  function test_rejectsMaximumUintRate() public {
    _setSourceFee(type(uint256).max);
    _expectInvalidRate(type(uint256).max);
  }

  function test_acceptsOneHundredPercent() public {
    _setSourceFee(1_000_000);
    assertEq(_buildEvmPayload().burnIntent.maxFee, GAS_FEE + 1_000_000);
  }

  function test_roundsFractionalFeeUp() public {
    _setSourceFee(51);
    assertEq(_maxFeeForAmount(1), GAS_FEE + 1);
    assertEq(_maxFeeForAmount(1_000_001), GAS_FEE + 52);
    assertEq(_maxFeeForAmount(1_000_000), GAS_FEE + 51);
  }

  function test_handlesIntermediateMultiplicationOverflow() public {
    _setSourceFee(50);
    uint256 amount = type(uint256).max;
    uint256 expected = amount / 20_000 + 1;
    assertEq(_maxFeeForAmount(amount), GAS_FEE + expected);
  }

  function test_bubblesUnexpectedSourceConfigError() public {
    _expectConfigFailure(
      builder.getSourceTransferFeeKey(CHAIN_ID),
      abi.encodeWithSignature("UnexpectedConfigFailure()")
    );
  }

  function test_doesNotTreatMissingDifferentKeyAsUnset() public {
    _expectConfigFailure(
      builder.getSourceTransferFeeKey(CHAIN_ID),
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        bytes32(uint256(123))
      )
    );
  }

  function testFuzz_matchesRoundedPercentage(
    uint128 amountSeed,
    uint32 rateSeed
  ) public {
    uint256 amount = bound(uint256(amountSeed), 1, type(uint128).max);
    uint256 rate = bound(uint256(rateSeed), 0, 1_000_000);
    _setSourceFee(rate);
    uint256 expected = (amount * rate + 999_999) / 1_000_000;
    assertEq(_maxFeeForAmount(amount), GAS_FEE + expected);
  }

  function testFuzz_preservesDefaultCalculation(uint256 amountSeed) public {
    uint256 amount = bound(amountSeed, 1, type(uint256).max);
    uint256 expected = amount / 20_000;
    if (amount % 20_000 != 0) ++expected;
    assertEq(_maxFeeForAmount(amount), GAS_FEE + expected);
  }

  function _setSourceFee(uint256 rate) internal {
    _setConfig(builder.getSourceTransferFeeKey(CHAIN_ID), bytes32(rate));
  }

  function _maxFeeForAmount(uint256 amount) internal returns (uint256) {
    WithdrawRequest memory params = _params();
    params.amount = amount;
    return
      abi
        .decode(
          buildPayloadOnly(builder, CHAIN_ID, params.depository, params),
          (GatewayVmPayload)
        )
        .burnIntent
        .maxFee;
  }

  function _expectInvalidRate(uint256 rate) internal {
    WithdrawRequest memory params = _params();
    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayVmPayloadBuilder.InvalidTransferFeePpm.selector,
        rate
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, params.depository, params);
  }

  function _expectConfigFailure(bytes32 key, bytes memory reason) internal {
    vm.mockCallRevert(
      address(config),
      abi.encodeCall(Config.getConfigValue, (key)),
      reason
    );
    WithdrawRequest memory params = _params();
    vm.expectRevert(reason);
    buildPayloadOnly(builder, CHAIN_ID, params.depository, params);
  }
}
