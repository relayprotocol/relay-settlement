// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {BuildPayloadParams} from "../../contracts/RelayAllocator.sol";
import {
  HederaRequestData,
  HederaTransferRequest,
  HederaVmPayloadBuilder
} from "../../contracts/payload-builders/HederaVmPayloadBuilder.sol";

abstract contract HederaVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "hedera";

  /// @dev Native Hedera USDC on mainnet, `0.0.456858`.
  uint64 internal constant USDC_TOKEN_NUM = 456858;

  /// @dev Reference accounts: depository `0.0.1001` (debited), receiver
  ///      `0.0.2002`, submitted through node `0.0.3` and paid for by the
  ///      submitter `0.0.98`, which is never the depository.
  uint64 internal constant SENDER_NUM = 1001;
  uint64 internal constant PAYER_NUM = 98;
  uint64 internal constant RECEIVER_NUM = 2002;
  uint64 internal constant NODE_NUM = 3;

  uint64 internal constant VALID_START_SECONDS = 1700000000;
  uint32 internal constant VALID_START_NANOS = 123456789;
  uint32 internal constant VALID_DURATION = 120;
  uint64 internal constant FEE = 100000000; // 1 HBAR, the builder's MAX_FEE

  HederaVmPayloadBuilder internal builder;

  function setUp() public virtual override {
    super.setUp();
    builder = new HederaVmPayloadBuilder(USDC_TOKEN_NUM);
  }

  /// @notice The 20-byte long-zero address an entity id encodes to, which is
  /// what the settlement SDK `hedera-vm` address codec produces.
  function _address(uint64 entityNum) internal pure returns (bytes memory) {
    return abi.encodePacked(bytes12(0), bytes8(entityNum));
  }

  function _hbar() internal pure returns (bytes memory) {
    return _address(0);
  }

  function _usdc() internal pure returns (bytes memory) {
    return _address(USDC_TOKEN_NUM);
  }

  function _data() internal pure returns (bytes memory) {
    return _dataWithFee(FEE);
  }

  function _dataWithFee(uint64 fee) internal pure returns (bytes memory) {
    return _dataWithPayerAndFee(PAYER_NUM, fee);
  }

  function _dataWithPayer(
    uint64 payerNum
  ) internal pure returns (bytes memory) {
    return _dataWithPayerAndFee(payerNum, FEE);
  }

  function _dataWithPayerAndFee(
    uint64 payerNum,
    uint64 fee
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        HederaRequestData({
          payerNum: payerNum,
          nodeAccountNum: NODE_NUM,
          validStartSeconds: VALID_START_SECONDS,
          validDurationSeconds: VALID_DURATION,
          maxTransactionFee: fee
        })
      );
  }

  function _params(
    bytes memory currency,
    uint256 amount
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: currency,
        amount: amount,
        receiver: _address(RECEIVER_NUM),
        nonce: 0,
        data: _data()
      });
  }

  function _build(
    BuildPayloadParams memory params
  ) internal view returns (HederaTransferRequest memory) {
    return
      abi.decode(
        builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params),
        (HederaTransferRequest)
      );
  }

  function _request(
    uint64 tokenNum,
    uint64 amount
  ) internal pure returns (HederaTransferRequest memory) {
    return _request(SENDER_NUM, RECEIVER_NUM, tokenNum, amount);
  }

  function _request(
    uint64 senderNum,
    uint64 receiverNum,
    uint64 tokenNum,
    uint64 amount
  ) internal pure returns (HederaTransferRequest memory) {
    return
      HederaTransferRequest({
        payerNum: PAYER_NUM,
        senderNum: senderNum,
        receiverNum: receiverNum,
        amount: amount,
        tokenNum: tokenNum,
        nodeAccountNum: NODE_NUM,
        validStartSeconds: VALID_START_SECONDS,
        validStartNanos: VALID_START_NANOS,
        validDurationSeconds: VALID_DURATION,
        maxTransactionFee: FEE
      });
  }
}

contract HederaVmPayloadBuilderConstructorTest is HederaVmPayloadBuilderBase {
  function test_storesTokenNum() public view {
    assertEq(uint256(builder.TOKEN_NUM()), uint256(USDC_TOKEN_NUM));
  }

  function test_exposesBounds() public view {
    assertEq(uint256(builder.MAX_FEE()), uint256(FEE));
    assertEq(uint256(builder.MAX_VALID_DURATION_SECONDS()), uint256(180));
  }

  function test_rejectsZeroTokenNum() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidTokenNum.selector,
        uint64(0)
      )
    );
    new HederaVmPayloadBuilder(0);
  }
}

contract HederaVmPayloadBuilderBuildPayloadTest is HederaVmPayloadBuilderBase {
  function test_buildsHbarTransfer() public {
    BuildPayloadParams memory params = _params(_hbar(), 500000000);

    HederaTransferRequest memory r = _build(params);
    assertEq(uint256(r.payerNum), uint256(PAYER_NUM));
    assertEq(uint256(r.senderNum), uint256(SENDER_NUM));
    assertEq(uint256(r.receiverNum), uint256(RECEIVER_NUM));
    assertEq(uint256(r.amount), 500000000);
    assertEq(uint256(r.tokenNum), 0);
    assertEq(uint256(r.nodeAccountNum), uint256(NODE_NUM));
    assertEq(uint256(r.validStartSeconds), uint256(VALID_START_SECONDS));
    // Derived from the withdraw parameters rather than supplied.
    assertLt(uint256(r.validStartNanos), 1000000000);
    assertEq(uint256(r.validDurationSeconds), uint256(VALID_DURATION));
    assertEq(uint256(r.maxTransactionFee), uint256(FEE));
  }

  function test_buildsUsdcTransfer() public {
    BuildPayloadParams memory params = _params(_usdc(), 1000000);

    HederaTransferRequest memory r = _build(params);
    assertEq(uint256(r.tokenNum), uint256(USDC_TOKEN_NUM));
    assertEq(uint256(r.amount), 1000000);
  }

  function test_rejectsUnsupportedToken() public {
    uint64 otherToken = USDC_TOKEN_NUM + 1;
    BuildPayloadParams memory params = _params(_address(otherToken), 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.UnsupportedCurrency.selector,
        otherToken
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  /// @dev An account's EVM alias is a 20-byte address whose first 12 bytes are
  /// not zero. Transferring to one would have Hedera auto-create a hollow
  /// account, which the protocol has not approved.
  function test_rejectsReceiverEvmAlias() public {
    bytes memory alias_ = hex"5e7b112523f68d2f5e879db4eac51c6698a69304";
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: alias_,
      nonce: 0,
      data: _data()
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.NotAnAccountId.selector,
        bytes20(alias_)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsCurrencyEvmAlias() public {
    bytes memory alias_ = hex"5e7b112523f68d2f5e879db4eac51c6698a69304";
    BuildPayloadParams memory params = _params(alias_, 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.NotAnAccountId.selector,
        bytes20(alias_)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsZeroReceiver() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(0),
      nonce: 0,
      data: _data()
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAccount.selector,
        uint64(0)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsReceiverEqualToSender() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(SENDER_NUM),
      nonce: 0,
      data: _data()
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.ReceiverIsSender.selector,
        SENDER_NUM
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  /// @dev The load-bearing check of the separate-payer design. A spender could
  /// otherwise name the depository as payer, and since the allocator signs for
  /// the depository the transaction would be valid — putting the fee back on the
  /// shared reserve.
  function test_rejectsPayerEqualToSender() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(RECEIVER_NUM),
      nonce: 0,
      data: _dataWithPayer(SENDER_NUM)
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.PayerIsSender.selector,
        SENDER_NUM
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsZeroPayer() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(RECEIVER_NUM),
      nonce: 0,
      data: _dataWithPayer(0)
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAccount.selector,
        uint64(0)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  /// @dev The payer arrives as a raw number rather than a long-zero address, so
  /// it never passes through `_entityNum`'s bound and is checked directly.
  function test_rejectsPayerAboveInt64Max() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(RECEIVER_NUM),
      nonce: 0,
      data: _dataWithPayer(tooLarge)
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.EntityNumExceedsMax.selector,
        tooLarge
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  /// @dev The fee is charged outside the transfer list, so the depository is
  /// debited the full amount and the list still nets to zero.
  function test_payerIsNotDebited() public {
    BuildPayloadParams memory params = _params(_hbar(), 500000000);
    HederaTransferRequest memory r = _build(params);
    assertEq(uint256(r.payerNum), uint256(PAYER_NUM));
    assertEq(uint256(r.senderNum), uint256(SENDER_NUM));
    assertTrue(r.payerNum != r.senderNum);
    assertEq(uint256(r.amount), 500000000);
  }

  function test_rejectsZeroAmount() public {
    BuildPayloadParams memory params = _params(_hbar(), 0);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAmount.selector,
        uint256(0)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsHbarAmountAboveTotalSupply() public {
    uint256 tooLarge = 5000000000000000001; // total supply in tinybars + 1
    BuildPayloadParams memory params = _params(_hbar(), tooLarge);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.AmountExceedsMax.selector,
        tooLarge,
        uint256(5000000000000000000)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsTokenAmountAboveSignedMax() public {
    uint256 tooLarge = uint256(uint64(type(int64).max)) + 1;
    BuildPayloadParams memory params = _params(_usdc(), tooLarge);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.AmountExceedsMax.selector,
        tooLarge,
        uint256(uint64(type(int64).max))
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsInvalidDepositoryLength() public {
    BuildPayloadParams memory params = _params(_hbar(), 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidDepositoryLength.selector,
        uint256(2)
      )
    );
    builder.buildPayload(CHAIN_ID, hex"1234", params);
  }

  function test_rejectsInvalidReceiverLength() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: hex"1234",
      nonce: 0,
      data: _data()
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsInvalidCurrencyLength() public {
    BuildPayloadParams memory params = _params(hex"1234", 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(2)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  /// @dev Hedera declares entity numbers as `int64`, so the top bit of the
  /// long-zero layout's 8-byte field is never legitimately set.
  function test_rejectsReceiverAboveInt64Max() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(tooLarge),
      nonce: 0,
      data: _data()
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.EntityNumExceedsMax.selector,
        tooLarge
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsDepositoryAboveInt64Max() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    BuildPayloadParams memory params = _params(_hbar(), 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.EntityNumExceedsMax.selector,
        tooLarge
      )
    );
    builder.buildPayload(CHAIN_ID, _address(tooLarge), params);
  }

  /// @dev The node account arrives as a raw number in `params.data`, so it does
  /// not pass through the long-zero decoder's bound.
  function test_rejectsNodeAccountAboveInt64Max() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(RECEIVER_NUM),
      nonce: 0,
      data: abi.encode(
        HederaRequestData({
          payerNum: PAYER_NUM,
          nodeAccountNum: tooLarge,
          validStartSeconds: VALID_START_SECONDS,
          validDurationSeconds: VALID_DURATION,
          maxTransactionFee: FEE
        })
      )
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.EntityNumExceedsMax.selector,
        tooLarge
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsZeroNodeAccount() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _hbar(),
      amount: 1,
      receiver: _address(RECEIVER_NUM),
      nonce: 0,
      data: abi.encode(
        HederaRequestData({
          payerNum: PAYER_NUM,
          nodeAccountNum: 0,
          validStartSeconds: VALID_START_SECONDS,
          validDurationSeconds: VALID_DURATION,
          maxTransactionFee: FEE
        })
      )
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAccount.selector,
        uint64(0)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function _paramsWithDuration(
    uint32 duration
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: _address(0),
        amount: 1,
        receiver: _address(RECEIVER_NUM),
        nonce: 0,
        data: abi.encode(
          HederaRequestData({
            payerNum: PAYER_NUM,
            nodeAccountNum: NODE_NUM,
            validStartSeconds: VALID_START_SECONDS,
            validDurationSeconds: duration,
            maxTransactionFee: FEE
          })
        )
      });
  }

  function test_rejectsZeroValidDuration() public {
    BuildPayloadParams memory params = _paramsWithDuration(0);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidValidDuration.selector,
        uint32(0)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_rejectsValidDurationAboveNetworkMaximum() public {
    BuildPayloadParams memory params = _paramsWithDuration(181);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidValidDuration.selector,
        uint32(181)
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_allowsValidDurationAtNetworkMaximum() public {
    BuildPayloadParams memory params = _paramsWithDuration(180);
    HederaTransferRequest memory r = _build(params);
    assertEq(uint256(r.validDurationSeconds), uint256(180));
  }

  /// @dev The nanosecond component is derived from the withdraw parameters, so
  /// that two withdrawal requests cannot collide on a transaction id.
  function test_derivesValidStartNanosBelowOneSecond() public {
    BuildPayloadParams memory params = _params(_hbar(), 500000000);
    HederaTransferRequest memory r = _build(params);
    assertLt(uint256(r.validStartNanos), 1000000000);
  }

  function test_derivesDifferentValidStartNanosPerNonce() public {
    BuildPayloadParams memory first = _params(_hbar(), 500000000);

    BuildPayloadParams memory second = _params(_hbar(), 500000000);
    second.nonce = 1;

    assertTrue(_build(first).validStartNanos != _build(second).validStartNanos);
  }

  /// @dev Purely a function of the parameters — no block state — so off-chain
  /// code can reproduce the payload.
  function test_derivesValidStartNanosDeterministically() public {
    BuildPayloadParams memory params = _params(_hbar(), 500000000);
    uint32 first = _build(params).validStartNanos;
    vm.roll(block.number + 100);
    vm.warp(block.timestamp + 1000);
    assertEq(uint256(_build(params).validStartNanos), uint256(first));
  }
}

contract HederaVmPayloadBuilderFeeTest is HederaVmPayloadBuilderBase {
  function _paramsWithFee(
    uint64 fee
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: _address(0),
        amount: 500000000,
        receiver: _address(RECEIVER_NUM),
        nonce: 0,
        data: _dataWithFee(fee)
      });
  }

  function test_rejectsFeeAboveMaxFee() public {
    uint64 tooLarge = FEE + 1;
    BuildPayloadParams memory params = _paramsWithFee(tooLarge);
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.FeeExceedsMaxFee.selector,
        tooLarge,
        FEE
      )
    );
    builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), params);
  }

  function test_allowsFeeAtMaxFee() public {
    BuildPayloadParams memory params = _paramsWithFee(FEE);
    HederaTransferRequest memory r = _build(params);
    assertEq(uint256(r.maxTransactionFee), uint256(FEE));
  }
}

/// @notice Golden Hedera transaction bodies. Every vector was produced by the
/// Hedera JavaScript SDK v2.81.0 (`TransferTransaction ... .freeze()`, taking
/// `bodyBytes`) for the same transfer, and the settlement SDK `hedera-vm`
/// withdrawal codec reproduces them too — a mismatch means the on-chain
/// serializer drifted from what Hedera itself would sign and submit.
contract HederaVmPayloadBuilderTransactionBodyTest is
  HederaVmPayloadBuilderBase
{
  function test_hbarBody() public view {
    assertEq(
      builder.transactionBody(_request(0, 500000000)),
      hex"0a170a0b0880e2cfaa0610959aef3a1206080010001862180012060800100018031880c2d72f22020878320072280a260a110a070800100018e90710ff93ebdc0318000a110a070800100018d20f108094ebdc031800"
    );
  }

  function test_usdcBody() public view {
    assertEq(
      builder.transactionBody(_request(USDC_TOKEN_NUM, 1000000)),
      hex"0a170a0b0880e2cfaa0610959aef3a1206080010001862180012060800100018031880c2d72f22020878320072300a00122c0a0808001000189af11b120f0a070800100018e90710ff887a1800120f0a070800100018d20f1080897a1800"
    );
  }

  /// @dev Hedera orders transfer entries by ascending account number, not
  /// debit-first, so a receiver below the depository swaps the two entries. The
  /// fee payer is not in the transfer list, so it does not affect the order.
  function test_hbarBodyWithReceiverBelowSender() public view {
    assertEq(
      builder.transactionBody(_request(RECEIVER_NUM, SENDER_NUM, 0, 7)),
      hex"0a170a0b0880e2cfaa0610959aef3a1206080010001862180012060800100018031880c2d72f22020878320072200a1e0a0d0a070800100018e907100e18000a0d0a070800100018d20f100d1800"
    );
  }

  function test_usdcBodyWithReceiverBelowSender() public view {
    assertEq(
      builder.transactionBody(_request(999999, 5, USDC_TOKEN_NUM, 1)),
      hex"0a170a0b0880e2cfaa0610959aef3a1206080010001862180012060800100018031880c2d72f220208783200722c0a0012280a0808001000189af11b120c0a0608001000180510021800120e0a080800100018bf843d10011800"
    );
  }

  /// @dev Multi-byte varints throughout: the largest entity number and the
  /// largest HBAR amount.
  function test_hbarBodyWithLargeValues() public view {
    assertEq(
      builder.transactionBody(
        _request(1, uint64(type(int64).max), 0, 5000000000000000000)
      ),
      hex"0a170a0b0880e2cfaa0610959aef3a1206080010001862180012060800100018031880c2d72f22020878320072380a360a150a0608001000180110ffff9fcfc8e0c8e38a0118000a1d0a0e0800100018ffffffffffffffff7f108080a0cfc8e0c8e38a011800"
    );
  }

  /// @dev `hashesToSign` takes a caller-supplied payload, so the serializer
  /// bounds entity numbers itself rather than trusting `buildPayload`.
  function test_bodyRejectsEntityNumAboveInt64Max() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    HederaTransferRequest memory r = _request(0, 1);
    r.receiverNum = tooLarge;
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.EntityNumExceedsMax.selector,
        tooLarge
      )
    );
    builder.transactionBody(r);
  }

  function test_bodyRejectsOutOfRangeValidStartNanos() public {
    HederaTransferRequest memory r = _request(0, 1);
    r.validStartNanos = 1000000000;
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidValidStartNanos.selector,
        uint32(1000000000)
      )
    );
    builder.transactionBody(r);
  }

  function test_bodyRejectsZeroAmount() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAmount.selector,
        uint256(0)
      )
    );
    builder.transactionBody(_request(0, 0));
  }

  /// @dev `hashesToSign` takes a caller-supplied payload, so the serializer
  /// re-checks the amount rather than trusting `buildPayload`: above the signed
  /// maximum the conversion to `sint64` would wrap and swap debit for credit.
  function test_bodyRejectsAmountAboveSignedMax() public {
    uint64 tooLarge = uint64(type(int64).max) + 1;
    vm.expectRevert(
      abi.encodeWithSelector(
        HederaVmPayloadBuilder.InvalidAmount.selector,
        uint256(tooLarge)
      )
    );
    builder.transactionBody(_request(0, tooLarge));
  }

  /// @dev Every bound field changes the body, so none of them can be tampered
  /// with after the allocator signs.
  function test_everyFieldIsBound() public view {
    bytes memory base = builder.transactionBody(_request(0, 500000000));

    HederaTransferRequest memory r = _request(0, 500000000);
    r.amount = 500000001;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.receiverNum = RECEIVER_NUM + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.payerNum = PAYER_NUM + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.tokenNum = USDC_TOKEN_NUM;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.nodeAccountNum = NODE_NUM + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.validStartSeconds = VALID_START_SECONDS + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.validStartNanos = VALID_START_NANOS + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.validDurationSeconds = VALID_DURATION + 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));

    r = _request(0, 500000000);
    r.maxTransactionFee = FEE - 1;
    assertTrue(keccak256(builder.transactionBody(r)) != keccak256(base));
  }
}

/// @notice Golden signing digests: `keccak256` of the bodies above, which is
/// what Hedera verifies an ECDSA secp256k1 signature against.
contract HederaVmPayloadBuilderHashesToSignTest is HederaVmPayloadBuilderBase {
  function _hash(
    HederaTransferRequest memory r
  ) internal view returns (bytes32) {
    return
      builder.hashesToSign(CHAIN_ID, _address(SENDER_NUM), abi.encode(r))[0];
  }

  function test_hbarDigest() public view {
    assertEq(
      _hash(_request(0, 500000000)),
      bytes32(
        hex"a45da741578cab3c272b3d84859bb0b44f187b8972af233c985ba71e35e0b343"
      )
    );
  }

  function test_usdcDigest() public view {
    assertEq(
      _hash(_request(USDC_TOKEN_NUM, 1000000)),
      bytes32(
        hex"6ff48edd5b88686908911c368548adbf4eb5e332415e890bd15568e00b510c4f"
      )
    );
  }

  function test_digestMatchesBody() public view {
    HederaTransferRequest memory r = _request(0, 500000000);
    assertEq(_hash(r), keccak256(builder.transactionBody(r)));
  }

  /// @dev Full path: buildPayload -> hashesToSign must digest the body of the
  /// payload that was actually built. The digest is not a fixed vector here,
  /// because the valid start's nanoseconds are derived from the withdraw
  /// parameters; the golden vectors above pin the serialization itself.
  function test_buildPayloadHashMatchesItsBody() public {
    BuildPayloadParams memory params = _params(_hbar(), 500000000);
    bytes memory payload = builder.buildPayload(
      CHAIN_ID,
      _address(SENDER_NUM),
      params
    );
    HederaTransferRequest memory built = abi.decode(
      payload,
      (HederaTransferRequest)
    );
    assertEq(
      builder.hashesToSign(CHAIN_ID, _address(SENDER_NUM), payload)[0],
      keccak256(builder.transactionBody(built))
    );
  }

  /// @dev Two withdrawal requests differing only by nonce must not share a
  /// transaction id, which is what the derived nanoseconds buy.
  function test_differentNoncesProduceDifferentDigests() public {
    BuildPayloadParams memory first = _params(_hbar(), 500000000);
    BuildPayloadParams memory second = _params(_hbar(), 500000000);
    second.nonce = 1;

    bytes32 firstHash = builder.hashesToSign(
      CHAIN_ID,
      _address(SENDER_NUM),
      builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), first)
    )[0];
    bytes32 secondHash = builder.hashesToSign(
      CHAIN_ID,
      _address(SENDER_NUM),
      builder.buildPayload(CHAIN_ID, _address(SENDER_NUM), second)
    )[0];
    assertTrue(firstHash != secondHash);
  }
}

contract HederaVmPayloadBuilderMetadataTest is HederaVmPayloadBuilderBase {
  function test_returnsExpectedCurve() public view {
    assertEq(builder.curve(), "Ecdsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(builder.family(), "hedera-vm");
  }
}
