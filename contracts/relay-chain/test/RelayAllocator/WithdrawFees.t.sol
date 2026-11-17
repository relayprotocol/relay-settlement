// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WithdrawRequestAuthorization} from "../../contracts/RelayAllocator.sol";

import {Authorization} from "../../contracts/Authorization.sol";

import {GatewayVmPayloadBuilderFeeIntegrationTest} from "../PayloadBuilders/GatewayVmPayloadBuilder.t.sol";
import {
  RelayAllocator,
  WithdrawRequest,
  WithdrawFee,
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization,
  IPayloadBuilder
} from "../../contracts/RelayAllocator.sol";
import {GatewayVmPayload} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {
  TonVmPayloadBuilder,
  TonTransferRequest
} from "../../contracts/payload-builders/TonVmPayloadBuilder.sol";
import {Utils} from "../../contracts/Utils.sol";
import {signWithdrawFee} from "../utils/WithdrawFeeSig.sol";

contract FixedWithdrawFeeBuilder is IPayloadBuilder {
  bytes private _currency;
  uint256 private immutable _amount;
  bool private immutable _emptyHashes;
  constructor(bytes memory currency, uint256 amount, bool emptyHashes) {
    _currency = currency;
    _amount = amount;
    _emptyHashes = emptyHashes;
  }
  function buildPayload(
    string calldata,
    bytes calldata,
    WithdrawRequest calldata request
  ) external view returns (bytes memory, WithdrawFee memory) {
    return (abi.encode(request.amount), WithdrawFee(_currency, _amount));
  }
  function hashesToSign(
    string calldata,
    bytes calldata,
    bytes calldata
  ) external view returns (bytes32[] memory) {
    return new bytes32[](_emptyHashes ? 0 : 1);
  }
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }
  function family() external pure returns (string memory) {
    return "test";
  }
}

contract WithdrawFeesTest is GatewayVmPayloadBuilderFeeIntegrationTest {
  uint256 private constant SPENDER_KEY = 123456;
  function setUp() public override {
    super.setUp();
    spender = vm.addr(SPENDER_KEY);
    spenderAlias = Utils.generateAddress("relay", abi.encodePacked(spender));
  }
  function _fund(uint256 principal, uint256 fee) internal {
    vm.startPrank(owner);
    hub.mint(spenderAlias, gatewayTokenId, principal);
    hub.mint(feePayerAlias, gatewayTokenId, fee);
    vm.stopPrank();
  }
  function _submit(
    WithdrawRequest memory request,
    WithdrawFeePaymentAuthorization memory authorization
  ) internal returns (bytes32) {
    vm.prank(spender);
    return allocator.submitWithdrawRequest(request, authorization);
  }
  function _signSpender(
    WithdrawRequest memory request,
    uint256 expiration
  ) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(
      SPENDER_KEY,
      allocator.hashWithdrawRequestAuthorization(request, expiration)
    );
    return abi.encodePacked(r, s, v);
  }
  function _assertUnconsumed(
    WithdrawRequest memory request,
    WithdrawFeePaymentAuthorization memory authorization
  ) internal view {
    assertFalse(
      allocator.usedWithdrawFeePaymentAuthorizations(
        allocator.hashWithdrawFeePaymentAuthorization(
          request,
          authorization.withdrawFeePayment,
          authorization.authorization.expiration
        )
      )
    );
    assertEq(allocator.payloads(keccak256(abi.encode(request))).length, 0);
    assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 0);
  }
  function test_builderReturnsFeeWithoutPaymentOrStateChanges() public view {
    WithdrawRequest memory request = _withdrawRequest(_params());
    (bytes memory encoded, WithdrawFee memory fee) = feeBuilder.buildPayload(
      CHAIN_ID,
      gatewayDepository,
      request
    );
    GatewayVmPayload memory payload = abi.decode(encoded, (GatewayVmPayload));
    assertEq(payload.burnIntent.spec.value, request.amount);
    assertEq(fee.currency, request.currency);
    assertEq(fee.amount, payload.burnIntent.maxFee);
    assertEq(fee.amount, PAID_GAS);
    assertEq(allocator.withdrawalsThisSecond(CHAIN_ID), 0);
  }
  function test_feeComesOnlyFromSeparatePayer() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS + 7);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS + 100
      );
    vm.expectEmit(true, true, true, true, address(allocator));
    emit RelayAllocator.WithdrawFeePaid(
      keccak256(abi.encode(request)),
      feePayerAlias,
      gatewayTokenId,
      PAID_GAS
    );
    bytes32 hash = _submit(request, authorization);
    assertEq(hash, keccak256(abi.encode(request)));
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 7);
    assertEq(
      abi
        .decode(allocator.payloads(hash), (GatewayVmPayload))
        .burnIntent
        .spec
        .value,
      request.amount
    );
    assertTrue(
      allocator.usedWithdrawFeePaymentAuthorizations(
        allocator.hashWithdrawFeePaymentAuthorization(
          request,
          authorization.withdrawFeePayment,
          authorization.authorization.expiration
        )
      )
    );
  }
  function test_suspendedFeePayerRollsBackAndCanRetryAfterUnsuspend() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory feeAuthorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    uint256 expiration = feeAuthorization.authorization.expiration;
    WithdrawRequestAuthorization
      memory requestAuthorization = WithdrawRequestAuthorization(
        request,
        Authorization(expiration, _signSpender(request, expiration))
      );
    vm.prank(owner);
    allocator.suspend(feePayerAlias);
    assertFalse(allocator.suspended(spenderAlias));

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.SpenderSuspended.selector,
        feePayerAlias
      )
    );
    allocator.submitWithdrawRequestWithSignature(
      requestAuthorization,
      feeAuthorization
    );

    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), request.amount);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), PAID_GAS);
    assertFalse(
      allocator.usedNonces(keccak256(request.spender), request.nonce)
    );
    _assertUnconsumed(request, feeAuthorization);

    vm.prank(owner);
    allocator.unsuspend(feePayerAlias);
    allocator.submitWithdrawRequestWithSignature(
      requestAuthorization,
      feeAuthorization
    );
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 0);
    assertTrue(allocator.usedNonces(keccak256(request.spender), request.nonce));
    assertTrue(
      allocator.usedWithdrawFeePaymentAuthorizations(
        allocator.hashWithdrawFeePaymentAuthorization(
          request,
          feeAuthorization.withdrawFeePayment,
          expiration
        )
      )
    );
  }
  function test_noAuthorizationCannotUseSpendersExtraFunds() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount + PAID_GAS, 0);
    vm.prank(spender);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeeExceedsLimit.selector,
        PAID_GAS,
        0
      )
    );
    allocator.submitWithdrawRequest(request);
    assertEq(
      hub.balanceOf(spenderAlias, gatewayTokenId),
      request.amount + PAID_GAS
    );
  }
  function test_unfundedPayerCannotFallBackToSpender() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount + PAID_GAS, PAID_GAS - 1);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    vm.expectRevert();
    _submit(request, authorization);
    _assertUnconsumed(request, authorization);
    assertEq(
      hub.balanceOf(spenderAlias, gatewayTokenId),
      request.amount + PAID_GAS
    );
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), PAID_GAS - 1);
  }
  function test_withdrawFeePaymentAuthorizationDoesNotAuthorizePrincipal()
    public
  {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.CallerIsNotApproved.selector,
        address(this)
      )
    );
    allocator.submitWithdrawRequest(request, authorization);
    _assertUnconsumed(request, authorization);
  }
  function test_failedPrincipalRollsBackPayerAndBothAuthorizations() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount - 1, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    uint256 expiration = block.timestamp + 100;
    bytes memory signature = _signSpender(request, expiration);
    vm.expectRevert();
    allocator.submitWithdrawRequestWithSignature(
      WithdrawRequestAuthorization(
        request,
        Authorization(expiration, signature)
      ),
      authorization
    );
    _assertUnconsumed(request, authorization);
    assertFalse(
      allocator.usedNonces(keccak256(request.spender), request.nonce)
    );
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), PAID_GAS);
    _fund(1, 0);
    allocator.submitWithdrawRequestWithSignature(
      WithdrawRequestAuthorization(
        request,
        Authorization(expiration, signature)
      ),
      authorization
    );
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 0);
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
    assertTrue(allocator.usedNonces(keccak256(request.spender), request.nonce));
  }
  function test_capAndCurrencyAreEnforced() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS - 1
      );
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeeExceedsLimit.selector,
        PAID_GAS,
        PAID_GAS - 1
      )
    );
    _submit(request, authorization);
    authorization.withdrawFeePayment.currency = hex"01";
    authorization.withdrawFeePayment.maxAmount = PAID_GAS;
    authorization = signWithdrawFee(
      FEE_ORACLE_KEY,
      allocator,
      request,
      authorization.withdrawFeePayment,
      authorization.authorization.expiration
    );
    vm.expectRevert(RelayAllocator.WithdrawFeeCurrencyMismatch.selector);
    _submit(request, authorization);
    _assertUnconsumed(request, authorization);
  }
  function testFuzz_cannotTamperWithPayment(uint8 field) public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    field = uint8(bound(field, 0, 3));
    if (field == 0)
      authorization.withdrawFeePayment.payer = abi.encodePacked(spender);
    if (field == 1) authorization.withdrawFeePayment.payerChainId = "other";
    if (field == 2) authorization.withdrawFeePayment.maxAmount++;
    if (field == 3) authorization.authorization.expiration++;
    vm.expectRevert(
      RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
    );
    _submit(request, authorization);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), PAID_GAS);
  }
  function test_changedReceiverOrNonceCannotUseAuthorization() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    request.receiver = abi.encodePacked(makeAddr("other-receiver"));
    vm.expectRevert(
      RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
    );
    _submit(request, authorization);
    request = _withdrawRequest(_params());
    request.nonce = bytes32(uint256(999));
    vm.expectRevert(
      RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
    );
    _submit(request, authorization);
  }
  function test_onlyRuntimeAmountIsExcludedFromFeeDigest() public view {
    WithdrawRequest memory request = _withdrawRequest(_params());
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    bytes32 digest = allocator.hashWithdrawFeePaymentAuthorization(
      request,
      authorization.withdrawFeePayment,
      authorization.authorization.expiration
    );
    bytes32 canonical = keccak256(abi.encode(request));
    request.amount++;
    assertEq(
      allocator.hashWithdrawFeePaymentAuthorization(
        request,
        authorization.withdrawFeePayment,
        authorization.authorization.expiration
      ),
      digest
    );
    assertNotEq(keccak256(abi.encode(request)), canonical);
    request.data = hex"1234";
    assertNotEq(
      allocator.hashWithdrawFeePaymentAuthorization(
        request,
        authorization.withdrawFeePayment,
        authorization.authorization.expiration
      ),
      digest
    );
  }
  function test_replayWithDifferentRuntimeAmountIsRejected() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount * 3, PAID_GAS * 3);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS + 100
      );
    bytes32 digest = allocator.hashWithdrawFeePaymentAuthorization(
      request,
      authorization.withdrawFeePayment,
      authorization.authorization.expiration
    );
    _submit(request, authorization);
    request.amount++;
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeePaymentAuthorizationUsed.selector,
        digest
      )
    );
    _submit(request, authorization);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), PAID_GAS * 2);
  }
  function test_expirationBoundaryAndRollback() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    vm.warp(authorization.authorization.expiration + 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayAllocator.WithdrawFeePaymentAuthorizationExpired.selector,
        authorization.authorization.expiration
      )
    );
    _submit(request, authorization);
    _assertUnconsumed(request, authorization);
    vm.warp(authorization.authorization.expiration);
    _submit(request, authorization);
  }
  function test_differentFeeCurrencyAndNonEvmPayer() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    FixedWithdrawFeeBuilder builder = new FixedWithdrawFeeBuilder(
      hex"42",
      12,
      false
    );
    vm.prank(owner);
    allocator.setPayloadBuilder(CHAIN_ID, gatewayDepository, address(builder));
    bytes memory payer = abi.encodePacked(bytes32(uint256(777)));
    address payerAlias = Utils.generateAddress("solana", payer);
    uint256 feeToken = Utils.generateTokenId(CHAIN_ID, hex"42");
    _fund(request.amount, 0);
    vm.prank(owner);
    hub.mint(payerAlias, feeToken, 12);
    WithdrawFeePaymentAuthorization memory authorization = signWithdrawFee(
      FEE_ORACLE_KEY,
      allocator,
      request,
      WithdrawFeePayment("solana", payer, hex"42", 12),
      block.timestamp
    );
    _submit(request, authorization);
    assertEq(hub.balanceOf(payerAlias, feeToken), 0);
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
  }
  function test_missingHashesRollBackFeeAndPrincipal() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    FixedWithdrawFeeBuilder builder = new FixedWithdrawFeeBuilder(
      request.currency,
      12,
      true
    );
    vm.prank(owner);
    allocator.setPayloadBuilder(CHAIN_ID, gatewayDepository, address(builder));
    _fund(request.amount, 12);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(request, 12);
    vm.expectRevert(RelayAllocator.NoHashesToSign.selector);
    _submit(request, authorization);
    _assertUnconsumed(request, authorization);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 12);
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), request.amount);
  }
  function test_zeroFeeNeedsNoPayer() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    FixedWithdrawFeeBuilder builder = new FixedWithdrawFeeBuilder("", 0, false);
    vm.prank(owner);
    allocator.setPayloadBuilder(CHAIN_ID, gatewayDepository, address(builder));
    _fund(request.amount, 0);
    vm.prank(spender);
    allocator.submitWithdrawRequest(request);
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
  }
  function test_erc1271OracleIsSupported() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    bytes32 digest = allocator.hashWithdrawFeePaymentAuthorization(
      request,
      authorization.withdrawFeePayment,
      authorization.authorization.expiration
    );
    authorization.authorization.signature = hex"1234";
    vm.etch(allocator.ORACLE_MULTISIG(), hex"00");
    vm.mockCall(
      allocator.ORACLE_MULTISIG(),
      abi.encodeWithSelector(
        bytes4(0x1626ba7e),
        digest,
        authorization.authorization.signature
      ),
      abi.encode(bytes4(0x1626ba7e))
    );
    _submit(request, authorization);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 0);
  }
  function test_withdrawFeePaymentAuthorizationMatchesSdkVector() public {
    address target = address(0x1234);
    vm.etch(target, address(allocator).code);
    vm.chainId(31337);
    WithdrawRequest memory request = WithdrawRequest(
      "gateway",
      hex"11",
      hex"22",
      1000000,
      "relay",
      hex"33",
      hex"44",
      hex"55",
      bytes32(uint256(1))
    );
    WithdrawFeePayment memory withdrawFeePayment = WithdrawFeePayment(
      "relay",
      hex"66",
      hex"22",
      50050
    );
    assertEq(
      RelayAllocator(target).hashWithdrawFeePaymentAuthorization(
        request,
        withdrawFeePayment,
        2000000000
      ),
      0xf564caaa347d2be6e2d0c172456ceacd1fbdf99bf941acc491c4c322eff6657d
    );
  }

  function testFuzz_fullRuntimeAmountIsPreserved(uint128 amountSeed) public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    request.amount = bound(uint256(amountSeed), 1, type(uint128).max);
    (, WithdrawFee memory fee) = feeBuilder.buildPayload(
      CHAIN_ID,
      gatewayDepository,
      request
    );
    _fund(request.amount, fee.amount);
    bytes32 hash = _submit(
      request,
      _withdrawFeePaymentAuthorization(request, fee.amount)
    );
    assertEq(
      abi
        .decode(allocator.payloads(hash), (GatewayVmPayload))
        .burnIntent
        .spec
        .value,
      request.amount
    );
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
    assertEq(hub.balanceOf(feePayerAlias, gatewayTokenId), 0);
  }

  function test_spenderSignatureCannotAuthorizePayerDebit() public {
    WithdrawRequest memory request = _withdrawRequest(_params());
    _fund(request.amount, PAID_GAS);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(
        request,
        PAID_GAS
      );
    authorization = signWithdrawFee(
      SPENDER_KEY,
      allocator,
      request,
      authorization.withdrawFeePayment,
      authorization.authorization.expiration
    );
    vm.expectRevert(
      RelayAllocator.InvalidWithdrawFeePaymentAuthorization.selector
    );
    _submit(request, authorization);
    _assertUnconsumed(request, authorization);
  }

  function test_tonFeeIsCollectedFromSeparatePayer() public {
    TonVmPayloadBuilder ton = new TonVmPayloadBuilder(
      address(config),
      address(allocator),
      "ton",
      0x10AD0001,
      3600
    );
    WithdrawRequest memory request = _withdrawRequest(_params());
    request.chainId = "ton";
    request.depository = abi.encodePacked(bytes32(uint256(1)));
    request.receiver = abi.encodePacked(bytes32(uint256(2)));
    request.currency = abi.encodePacked(bytes32(0));
    request.data = "";
    uint256 token = Utils.generateTokenId(request.chainId, request.currency);
    bytes32 configKey = ton.getGasFeeKey("ton");
    vm.startPrank(owner);
    allocator.setPayloadBuilder("ton", request.depository, address(ton));
    config.setConfigValue(configKey, bytes32(uint256(100)));
    hub.mint(spenderAlias, token, request.amount);
    hub.mint(feePayerAlias, token, 100);
    vm.stopPrank();
    bytes32 hash = _submit(
      request,
      _withdrawFeePaymentAuthorization(request, 100)
    );
    assertEq(hub.balanceOf(spenderAlias, token), 0);
    assertEq(hub.balanceOf(feePayerAlias, token), 0);
    assertEq(
      abi.decode(allocator.payloads(hash), (TonTransferRequest)).amount,
      request.amount
    );
  }
}
