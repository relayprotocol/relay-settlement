// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WithdrawGasPayerBase} from "./WithdrawGasPayerBase.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayAllocator} from "../../contracts/RelayAllocator.sol";
import {GasPaidPayloadBuilder} from "../../contracts/payload-builders/GasPaidPayloadBuilder.sol";
import {TonVmPayloadBuilder} from "../../contracts/payload-builders/TonVmPayloadBuilder.sol";

/// @notice End-to-end flow: pay gas via WithdrawGasPayer, then submit the same
/// withdraw request to the allocator with a gas-gated TON payload builder.
contract WithdrawGasPayerIntegrationTest is WithdrawGasPayerBase {
  uint32 internal constant SUBWALLET_ID = 0x10AD0001;
  uint32 internal constant TIMEOUT = 3600;

  RelayAllocator internal allocator;
  Config internal config;
  TonVmPayloadBuilder internal payloadBuilder;

  function setUp() public override {
    super.setUp();

    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    payloadBuilder = new TonVmPayloadBuilder(
      address(config),
      SUBWALLET_ID,
      TIMEOUT,
      address(gasPayer)
    );

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, address(allocator));
    config.setConfigValue(
      payloadBuilder.getGasFeeKey(CHAIN_ID),
      bytes32(GAS_FEE_AMOUNT)
    );
    allocator.setPayloadBuilder(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY_HASH),
      address(payloadBuilder)
    );
    vm.stopPrank();
  }

  function test_withdrawSucceedsAfterGasPayment() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(1))
    );
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT + WITHDRAW_AMOUNT);

    gasPayer.payGas(
      request,
      NATIVE_CURRENCY,
      GAS_FEE_AMOUNT,
      _signPayGas(request)
    );

    vm.prank(spender);
    bytes32 withdrawRequestHash = allocator.submitWithdrawRequest(request);

    // Both the gas fee and the withdrawal amount were burned (native TON
    // shares one token id), and the payload was built and stored.
    assertEq(hub.balanceOf(spenderAlias, gasTokenId), 0);
    assertGt(allocator.payloads(withdrawRequestHash).length, 0);
    assertTrue(allocator.hashesToSign(withdrawRequestHash, 0) != bytes32(0));
  }

  function test_withdrawRevertsWithoutGasPayment() public {
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(
      bytes32(uint256(2))
    );
    _mintGasFunds(spenderAlias, WITHDRAW_AMOUNT);

    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        _withdrawParamsHash(request)
      )
    );
    vm.prank(spender);
    allocator.submitWithdrawRequest(request);
  }

  function test_gasPaymentForDifferentParamsDoesNotUnlockWithdraw() public {
    RelayAllocator.WithdrawRequest memory paid = _withdrawRequest(
      bytes32(uint256(3))
    );
    RelayAllocator.WithdrawRequest memory submitted = _withdrawRequest(
      bytes32(uint256(4))
    );
    _mintGasFunds(spenderAlias, GAS_FEE_AMOUNT + WITHDRAW_AMOUNT);

    gasPayer.payGas(paid, NATIVE_CURRENCY, GAS_FEE_AMOUNT, _signPayGas(paid));

    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        _withdrawParamsHash(submitted)
      )
    );
    vm.prank(spender);
    allocator.submitWithdrawRequest(submitted);
  }
}
