// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {PayGasSig} from "../utils/PayGasSig.sol";
import {
  BuildPayloadParams,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";
import {GasPaidPayloadBuilder} from "../../contracts/payload-builders/GasPaidPayloadBuilder.sol";
import {
  XrpVmPayloadBuilder,
  XrpPaymentRequest,
  XrpRequestData
} from "../../contracts/payload-builders/XrpVmPayloadBuilder.sol";

abstract contract XrpVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "xrp";

  // 33-byte compressed secp256k1 signing key (matches the settlement SDK
  // xrp-vm withdrawal codec reference vectors).
  bytes internal constant SIGNING_PUBKEY =
    hex"0388935426e0d08083314842edfbb2d517bd47699f9a4527318a8e10468c97c052";

  // Reference AccountIDs (r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59 sender,
  // rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh receiver).
  bytes20 internal constant ACCOUNT =
    bytes20(hex"5e7b112523f68d2f5e879db4eac51c6698a69304");
  bytes20 internal constant DESTINATION =
    bytes20(hex"b5f762798a53d543a014caf8b297cff8f2f937e8");

  // 20-byte native XRP currency sentinel (all zero).
  bytes internal constant NATIVE_CURRENCY =
    hex"0000000000000000000000000000000000000000";

  // Mirrors the contract's hardcoded MAX_FEE constant (~1 XRP in drops).
  uint64 internal constant MAX_FEE = 1000000;

  uint256 internal constant GAS_FEE_AMOUNT = 100000; // 0.1 XRP in drops

  RelayHub internal hub;
  WithdrawGasPayer internal gasPayer;
  XrpVmPayloadBuilder internal builder;

  address internal spender;
  address internal spenderAlias;
  uint256 internal gasTokenId;

  address internal oracle;
  uint256 internal oraclePk;

  function setUp() public virtual override {
    super.setUp();

    (oracle, oraclePk) = makeAddrAndKey("oracle");

    hub = new RelayHub(owner);
    gasPayer = new WithdrawGasPayer(address(hub), oracle);
    builder = new XrpVmPayloadBuilder(SIGNING_PUBKEY, address(gasPayer));

    spender = makeAddr("spender");
    spenderAlias = Utils.generateAddress(CHAIN_ID, abi.encodePacked(spender));
    gasTokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, owner);
    hub.grantRole(operatorRole, address(gasPayer));
    vm.stopPrank();
  }

  /// @notice Pays the gas fee for the exact parameters that will be passed to
  /// `buildPayload`, unlocking the gas payment gate. Mirrors the off-chain
  /// flow: the oracle signs the request and anyone submits the payment.
  function _payGas(
    bytes memory depository,
    BuildPayloadParams memory params
  ) internal {
    _payGasOnChain(CHAIN_ID, depository, params, GAS_FEE_AMOUNT);
  }

  /// @notice Same as `_payGas` but for an arbitrary chain id, so tests can
  /// exercise oracle-authorized fees other than the fixture's default.
  function _payGasOnChain(
    string memory chainId,
    bytes memory depository,
    BuildPayloadParams memory params,
    uint256 feeAmount
  ) internal {
    uint256 tokenId = Utils.generateTokenId(chainId, NATIVE_CURRENCY);
    vm.prank(owner);
    hub.mint(spenderAlias, tokenId, feeAmount);

    RelayAllocator.WithdrawRequest memory request = RelayAllocator
      .WithdrawRequest({
        chainId: chainId,
        depository: depository,
        currency: params.currency,
        amount: params.amount,
        spenderChainId: CHAIN_ID,
        spender: abi.encodePacked(spender),
        receiver: params.receiver,
        data: params.data,
        nonce: bytes32(params.nonce)
      });
    gasPayer.payGas(
      request,
      NATIVE_CURRENCY,
      feeAmount,
      PayGasSig.sign(oraclePk, gasPayer, request, NATIVE_CURRENCY, feeAmount)
    );
  }

  function _request(
    uint64 amount,
    uint64 fee,
    uint32 sequence,
    uint32 lastLedgerSequence,
    uint32 flags,
    uint32 destinationTag,
    bool hasDestinationTag
  ) internal pure returns (XrpPaymentRequest memory) {
    return
      XrpPaymentRequest({
        account: ACCOUNT,
        destination: DESTINATION,
        amount: amount,
        fee: fee,
        sequence: sequence,
        lastLedgerSequence: lastLedgerSequence,
        flags: flags,
        destinationTag: destinationTag,
        hasDestinationTag: hasDestinationTag,
        signingPubKey: SIGNING_PUBKEY
      });
  }
}

contract XrpVmPayloadBuilderConstructorTest is XrpVmPayloadBuilderBase {
  function test_storesSigningPubKey() public view {
    assertTrue(builder.SIGNING_PUBKEY_PREFIX() == bytes1(0x03));
    assertEq(
      builder.SIGNING_PUBKEY_BODY(),
      bytes32(
        hex"88935426e0d08083314842edfbb2d517bd47699f9a4527318a8e10468c97c052"
      )
    );
  }

  function test_exposesMaxFee() public view {
    assertEq(uint256(builder.MAX_FEE()), uint256(MAX_FEE));
  }

  function test_rejectsWrongLengthKey() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidSigningPubKeyLength.selector,
        uint256(32)
      )
    );
    new XrpVmPayloadBuilder(new bytes(32), address(gasPayer));
  }

  function test_storesGasPayer() public view {
    assertEq(builder.GAS_PAYER(), address(gasPayer));
  }

  function test_rejectsUncompressedKeyPrefix() public {
    bytes memory bad = SIGNING_PUBKEY;
    bad[0] = 0x04;
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidSigningPubKeyPrefix.selector,
        bytes1(0x04)
      )
    );
    new XrpVmPayloadBuilder(bad, address(gasPayer));
  }
}

contract XrpVmPayloadBuilderBuildPayloadTest is XrpVmPayloadBuilderBase {
  function _data(XrpRequestData memory d) internal pure returns (bytes memory) {
    return abi.encode(d);
  }

  function _defaultData() internal pure returns (bytes memory) {
    return
      _data(
        XrpRequestData({
          sequence: 42,
          fee: 12,
          lastLedgerSequence: 1000,
          flags: 0x80000000,
          destinationTag: 0,
          hasDestinationTag: false
        })
      );
  }

  function test_buildsNativeXrpPayment() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _defaultData()
    });
    _payGas(abi.encodePacked(ACCOUNT), params);

    bytes memory payload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));

    assertEq(bytes32(r.account), bytes32(ACCOUNT));
    assertEq(bytes32(r.destination), bytes32(DESTINATION));
    assertEq(uint256(r.amount), 1000000);
    assertEq(uint256(r.fee), 12);
    assertEq(uint256(r.sequence), 42);
    assertEq(uint256(r.lastLedgerSequence), 1000);
    assertEq(uint256(r.flags), 0x80000000);
    assertEq(r.hasDestinationTag, false);
    assertEq(r.signingPubKey, SIGNING_PUBKEY);
  }

  function test_rejectsInvalidReceiverLength() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1,
      receiver: hex"1234",
      nonce: 0,
      data: _defaultData()
    });
    _payGas(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsInvalidDepositoryLength() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _defaultData()
    });
    _payGas(hex"1234", params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidDepositoryLength.selector,
        uint256(2)
      )
    );
    builder.buildPayload(CHAIN_ID, hex"1234", params);
  }

  function test_rejectsNonNativeCurrency() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: abi.encodePacked(DESTINATION), // non-zero AccountID
      amount: 1,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _defaultData()
    });
    _payGas(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(XrpVmPayloadBuilder.UnsupportedCurrency.selector);
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsAmountAboveMaxDrops() public {
    uint256 tooLarge = 100000000000000001; // MAX_DROPS + 1
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: tooLarge,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _defaultData()
    });
    _payGas(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.AmountExceedsMaxDrops.selector,
        tooLarge
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsFeeAboveMaxFee() public {
    uint64 tooLarge = MAX_FEE + 1;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: tooLarge,
          lastLedgerSequence: 1000,
          flags: 0x80000000,
          destinationTag: 0,
          hasDestinationTag: false
        })
      )
    });
    _payGas(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.FeeExceedsMaxFee.selector,
        tooLarge,
        MAX_FEE
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_allowsFeeAtMaxFee() public {
    // A fee at MAX_FEE also needs an oracle-authorized gas payment covering it.
    string memory maxFeeChainId = "xrp-max-fee";

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: MAX_FEE,
          lastLedgerSequence: 1000,
          flags: 0x80000000,
          destinationTag: 0,
          hasDestinationTag: false
        })
      )
    });
    _payGasOnChain(maxFeeChainId, abi.encodePacked(ACCOUNT), params, MAX_FEE);
    bytes memory payload = builder.buildPayload(
      maxFeeChainId,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));
    assertEq(uint256(r.fee), uint256(MAX_FEE));
  }

  function test_buildPayloadHashMatchesReference() public {
    // Full path: buildPayload -> hashesToSign must equal the V1 reference.
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      receiver: abi.encodePacked(DESTINATION),
      nonce: 0,
      data: _defaultData()
    });
    _payGas(abi.encodePacked(ACCOUNT), params);
    bytes memory payload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    bytes32[] memory hashes = builder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      payload
    );
    assertEq(
      hashes[0],
      bytes32(
        hex"a434eadb919b76bc3a84a284f19bba69af15d35533e4211cb4a8e44104c4f007"
      )
    );
  }
}

contract XrpVmPayloadBuilderGasPaymentTest is XrpVmPayloadBuilderBase {
  function _params() internal pure returns (BuildPayloadParams memory) {
    return _paramsWithFee(12);
  }

  function _paramsWithFee(
    uint64 fee
  ) internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: NATIVE_CURRENCY,
        amount: 1000000,
        receiver: abi.encodePacked(DESTINATION),
        nonce: 0,
        data: abi.encode(
          XrpRequestData({
            sequence: 42,
            fee: fee,
            lastLedgerSequence: 1000,
            flags: 0x80000000,
            destinationTag: 0,
            hasDestinationTag: false
          })
        )
      });
  }

  function test_allowsFeeEqualToPaidGas() public {
    // GAS_FEE_AMOUNT (the burned amount) is below MAX_FEE, so the paid-gas
    // bound is the binding constraint here.
    BuildPayloadParams memory params = _paramsWithFee(uint64(GAS_FEE_AMOUNT));
    _payGas(abi.encodePacked(ACCOUNT), params);

    bytes memory payload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));
    assertEq(uint256(r.fee), GAS_FEE_AMOUNT);
  }

  function test_rejectsFeeAbovePaidGas() public {
    uint64 fee = uint64(GAS_FEE_AMOUNT) + 1; // still below MAX_FEE
    BuildPayloadParams memory params = _paramsWithFee(fee);
    _payGas(abi.encodePacked(ACCOUNT), params);

    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.FeeExceedsPaidGas.selector,
        fee,
        GAS_FEE_AMOUNT
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsBuildWithoutGasPayment() public {
    BuildPayloadParams memory params = _params();
    bytes32 expectedHash = keccak256(
      abi.encode(CHAIN_ID, abi.encodePacked(ACCOUNT), params)
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        expectedHash
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsBuildWhenGasPaidForDifferentParams() public {
    BuildPayloadParams memory paid = _params();
    _payGas(abi.encodePacked(ACCOUNT), paid);

    BuildPayloadParams memory unpaid = _params();
    unpaid.nonce = paid.nonce + 1;
    bytes32 expectedHash = keccak256(
      abi.encode(CHAIN_ID, abi.encodePacked(ACCOUNT), unpaid)
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        expectedHash
      )
    );
    builder.buildPayload(CHAIN_ID, abi.encodePacked(ACCOUNT), unpaid);
  }
}

/// @notice Golden XRPL single-signing hashes. These mirror the settlement SDK
/// xrp-vm withdrawal codec (getId) and were produced with ripple-binary-codec;
/// a mismatch means the on-chain serializer/hash drifted from the SDK.
contract XrpVmPayloadBuilderHashesToSignTest is XrpVmPayloadBuilderBase {
  function _hash(XrpPaymentRequest memory r) internal view returns (bytes32) {
    return
      builder.hashesToSign(CHAIN_ID, abi.encodePacked(ACCOUNT), abi.encode(r))[
        0
      ];
  }

  function test_referenceV1_noTag() public view {
    XrpPaymentRequest memory r = _request(
      1000000,
      12,
      42,
      1000,
      0x80000000,
      0,
      false
    );
    assertEq(
      _hash(r),
      bytes32(
        hex"a434eadb919b76bc3a84a284f19bba69af15d35533e4211cb4a8e44104c4f007"
      )
    );
  }

  function test_referenceV2_destinationTagZero() public view {
    XrpPaymentRequest memory r = _request(1, 10, 1, 2, 0, 0, true);
    assertEq(
      _hash(r),
      bytes32(
        hex"d50df11a1fac07e761446dd8c38f07a76a832f21834436676cf3aa6b5e37730d"
      )
    );
  }

  function test_referenceV3_maxFieldsWithTag() public view {
    XrpPaymentRequest memory r = _request(
      99999999999999999,
      1000,
      4294967295,
      4294967295,
      0x80000000,
      305419896,
      true
    );
    assertEq(
      _hash(r),
      bytes32(
        hex"9aea05f716d0042d5987bcbd1f0d11076be4cee6b00ce22cd7d5ca525ddf2063"
      )
    );
  }

  function test_destinationTagPresenceChangesHash() public view {
    XrpPaymentRequest memory withTag = _request(1, 10, 1, 2, 0, 0, true);
    XrpPaymentRequest memory withoutTag = _request(1, 10, 1, 2, 0, 0, false);
    assertTrue(_hash(withTag) != _hash(withoutTag));
  }
}

contract XrpVmPayloadBuilderMetadataTest is XrpVmPayloadBuilderBase {
  function test_returnsExpectedCurve() public view {
    assertEq(builder.curve(), "Ecdsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(builder.family(), "xrp-vm");
  }
}
