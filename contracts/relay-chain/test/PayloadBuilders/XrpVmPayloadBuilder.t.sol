// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization,
  WithdrawFee,
  WithdrawRequest,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {signWithdrawFee} from "../utils/WithdrawFeeSig.sol";
import {Utils} from "../../contracts/Utils.sol";
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

  // Fixed InvoiceID for the reference vectors (sha256("test")); built payloads
  // carry keccak256(abi.encode(builder, request)) instead.
  bytes32 internal constant INVOICE_ID =
    hex"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  // Mirrors the contract's hardcoded MAX_FEE constant (~1 XRP in drops).
  uint64 internal constant MAX_FEE = 1000000;

  uint256 internal constant GAS_FEE_AMOUNT = 100000; // 0.1 XRP in drops

  RelayHub internal hub;
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
    builder = new XrpVmPayloadBuilder(SIGNING_PUBKEY);

    spender = makeAddr("spender");
    spenderAlias = Utils.generateAddress(CHAIN_ID, abi.encodePacked(spender));
    gasTokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, owner);
    vm.stopPrank();
  }

  /// @notice Sets the full request identity before constructing a payload.
  function _setRequestContext(
    bytes memory depository,
    WithdrawRequest memory params
  ) internal {
    _setRequestChain(CHAIN_ID, depository, params);
  }

  /// @notice Sets the request identity for an alternate spender or chain.
  function _setRequestChain(
    string memory chainId,
    bytes memory depository,
    WithdrawRequest memory params
  ) internal {
    params.chainId = chainId;
    params.depository = depository;
    params.spenderChainId = CHAIN_ID;
    params.spender = abi.encodePacked(spender);
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
        signingPubKey: SIGNING_PUBKEY,
        invoiceId: INVOICE_ID
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

  function test_exposesAllowedFlags() public view {
    assertEq(uint256(builder.ALLOWED_FLAGS()), uint256(0x80000000));
  }

  function test_rejectsWrongLengthKey() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidSigningPubKeyLength.selector,
        uint256(32)
      )
    );
    new XrpVmPayloadBuilder(new bytes(32));
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
    new XrpVmPayloadBuilder(bad);
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
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _defaultData(),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);

    bytes memory payload = buildPayloadOnly(
      builder,
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
    assertEq(r.invoiceId, keccak256(abi.encode(address(builder), params)));
  }

  function test_rejectsInvalidReceiverLength() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: hex"1234",
      data: _defaultData(),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsInvalidDepositoryLength() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: hex"1234",
      currency: NATIVE_CURRENCY,
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _defaultData(),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(hex"1234", params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.InvalidDepositoryLength.selector,
        uint256(2)
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, hex"1234", params);
  }

  function test_rejectsNonNativeCurrency() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: abi.encodePacked(DESTINATION), // non-zero AccountID
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _defaultData(),
      nonce: bytes32(0)
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(XrpVmPayloadBuilder.UnsupportedCurrency.selector);
    buildPayloadOnly(builder, CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsAmountAboveMaxDrops() public {
    uint256 tooLarge = 100000000000000001; // MAX_DROPS + 1
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: tooLarge,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _defaultData(),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.AmountExceedsMaxDrops.selector,
        tooLarge
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_rejectsFeeAboveMaxFee() public {
    uint64 tooLarge = MAX_FEE + 1;
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: tooLarge,
          lastLedgerSequence: 1000,
          flags: 0x80000000,
          destinationTag: 0,
          hasDestinationTag: false
        })
      ),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.FeeExceedsMaxFee.selector,
        tooLarge,
        MAX_FEE
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_allowsFeeAtMaxFee() public {
    // A fee at MAX_FEE is valid and is returned for allocator collection.
    string memory maxFeeChainId = "xrp-max-fee";

    WithdrawRequest memory params = WithdrawRequest({
      chainId: maxFeeChainId,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: MAX_FEE,
          lastLedgerSequence: 1000,
          flags: 0x80000000,
          destinationTag: 0,
          hasDestinationTag: false
        })
      ),
      nonce: bytes32(uint256(0))
    });
    _setRequestChain(maxFeeChainId, abi.encodePacked(ACCOUNT), params);
    bytes memory payload = buildPayloadOnly(
      builder,
      maxFeeChainId,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));
    assertEq(uint256(r.fee), uint256(MAX_FEE));
  }

  function test_rejectsUnsupportedFlags() public {
    uint32 flags = 0x80020000; // tfFullyCanonicalSig | tfPartialPayment
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: 12,
          lastLedgerSequence: 1000,
          flags: flags,
          destinationTag: 0,
          hasDestinationTag: false
        })
      ),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        XrpVmPayloadBuilder.UnsupportedFlags.selector,
        flags
      )
    );
    buildPayloadOnly(builder, CHAIN_ID, abi.encodePacked(ACCOUNT), params);
  }

  function test_allowsZeroFlags() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _data(
        XrpRequestData({
          sequence: 42,
          fee: 12,
          lastLedgerSequence: 1000,
          flags: 0,
          destinationTag: 0,
          hasDestinationTag: false
        })
      ),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    bytes memory payload = buildPayloadOnly(
      builder,
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));
    assertEq(uint256(r.flags), 0);
  }

  function test_buildPayloadBindsInvoiceIdIntoSigningHash() public {
    // Full path: the payload is the V1 Payment plus the request-derived
    // InvoiceID, and the signed hash is no longer the pre-InvoiceID V1 hash.
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: abi.encodePacked(ACCOUNT),
      currency: NATIVE_CURRENCY,
      amount: 1000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(DESTINATION),
      data: _defaultData(),
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(abi.encodePacked(ACCOUNT), params);
    bytes memory payload = buildPayloadOnly(
      builder,
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    bytes32[] memory hashes = builder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      payload
    );

    XrpPaymentRequest memory expected = _request(
      1000000,
      12,
      42,
      1000,
      0x80000000,
      0,
      false
    );
    expected.invoiceId = keccak256(abi.encode(address(builder), params));
    assertEq(payload, abi.encode(expected));
    assertTrue(
      hashes[0] !=
        bytes32(
          hex"a434eadb919b76bc3a84a284f19bba69af15d35533e4211cb4a8e44104c4f007"
        )
    );
  }
}

contract XrpVmPayloadBuilderFeeTest is XrpVmPayloadBuilderBase {
  function _params() internal pure returns (WithdrawRequest memory) {
    return _paramsWithFee(12);
  }

  function _paramsWithFee(
    uint64 fee
  ) internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: abi.encodePacked(ACCOUNT),
        currency: NATIVE_CURRENCY,
        amount: 1000000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: abi.encodePacked(DESTINATION),
        data: abi.encode(
          XrpRequestData({
            sequence: 42,
            fee: fee,
            lastLedgerSequence: 1000,
            flags: 0x80000000,
            destinationTag: 0,
            hasDestinationTag: false
          })
        ),
        nonce: bytes32(uint256(0))
      });
  }

  function test_buildIncludesTransactionFee() public {
    // GAS_FEE_AMOUNT (the burned amount) is below MAX_FEE, so the paid-gas
    // bound is the binding constraint here.
    WithdrawRequest memory params = _paramsWithFee(uint64(GAS_FEE_AMOUNT));
    _setRequestContext(abi.encodePacked(ACCOUNT), params);

    bytes memory payload = buildPayloadOnly(
      builder,
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    XrpPaymentRequest memory r = abi.decode(payload, (XrpPaymentRequest));
    assertEq(uint256(r.fee), GAS_FEE_AMOUNT);
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
        hex"c1707ed97eb40e25a303c1d07cf71e35b1aa69cff2a3140199061e0de2a27efb"
      )
    );
  }

  function test_referenceV2_destinationTagZero() public view {
    XrpPaymentRequest memory r = _request(1, 10, 1, 2, 0, 0, true);
    assertEq(
      _hash(r),
      bytes32(
        hex"8838738b7fe9bc013cd4b2a082656a7ffd221362837cb08f39350d800850d39e"
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
        hex"cceaf04f1dcb462a5509218093e28efdccf2a1e364fa296b192b0ef14a33ed5a"
      )
    );
  }

  function test_destinationTagPresenceChangesHash() public view {
    XrpPaymentRequest memory withTag = _request(1, 10, 1, 2, 0, 0, true);
    XrpPaymentRequest memory withoutTag = _request(1, 10, 1, 2, 0, 0, false);
    assertTrue(_hash(withTag) != _hash(withoutTag));
  }

  function test_invoiceIdChangesHash() public view {
    XrpPaymentRequest memory a = _request(1, 10, 1, 2, 0, 0, false);
    XrpPaymentRequest memory b = _request(1, 10, 1, 2, 0, 0, false);
    b.invoiceId = bytes32(uint256(INVOICE_ID) ^ 1);
    assertTrue(_hash(a) != _hash(b));
  }
}

/// @notice Cyfrin #19: two requests with identical XRP data (same sequence) must
/// not share a signing hash, or one payout would attest both as executed
contract XrpVmPayloadBuilderRequestHashTest is XrpVmPayloadBuilderBase {
  function _params(
    address requestSpender
  ) internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: abi.encodePacked(ACCOUNT),
        currency: NATIVE_CURRENCY,
        amount: 1000000,
        spenderChainId: "relay",
        spender: abi.encodePacked(requestSpender),
        receiver: abi.encodePacked(DESTINATION),
        data: abi.encode(
          XrpRequestData({
            sequence: 42,
            fee: 12,
            lastLedgerSequence: 1000,
            flags: 0x80000000,
            destinationTag: 0,
            hasDestinationTag: false
          })
        ),
        nonce: bytes32(0)
      });
  }

  function _signingHash(
    WithdrawRequest memory params
  ) internal view returns (bytes32) {
    bytes memory payload = buildPayloadOnly(
      builder,
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      params
    );
    return
      builder.hashesToSign(CHAIN_ID, abi.encodePacked(ACCOUNT), payload)[0];
  }

  function test_derivesDifferentSigningHashPerRequest() public {
    WithdrawRequest memory a = _params(address(1));
    WithdrawRequest memory b = _params(address(2));

    assertTrue(_signingHash(a) != _signingHash(b));
  }

  function test_derivesSameSigningHashForSameRequest() public {
    WithdrawRequest memory a = _params(address(1));

    assertEq(_signingHash(a), _signingHash(_params(address(1))));
  }

  function test_twoSpendersWithIdenticalDataGetDifferentSigningHashes() public {
    RelayAllocator allocator = new RelayAllocator(owner, address(hub), oracle);
    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    allocator.setPayloadBuilder(
      CHAIN_ID,
      abi.encodePacked(ACCOUNT),
      address(builder)
    );
    vm.stopPrank();

    address spenderA = makeAddr("spenderA");
    address spenderB = makeAddr("spenderB");
    WithdrawRequest memory a = _params(spenderA);
    WithdrawRequest memory b = _params(spenderB);

    vm.startPrank(owner);
    hub.mint(
      Utils.generateAddress("relay", abi.encodePacked(spenderA)),
      gasTokenId,
      a.amount + 12
    );
    hub.mint(
      Utils.generateAddress("relay", abi.encodePacked(spenderB)),
      gasTokenId,
      b.amount + 12
    );
    vm.stopPrank();

    WithdrawFeePaymentAuthorization memory authA = signWithdrawFee(
      oraclePk,
      allocator,
      a,
      WithdrawFeePayment("relay", abi.encodePacked(spenderA), a.currency, 12),
      block.timestamp + 1 hours
    );
    WithdrawFeePaymentAuthorization memory authB = signWithdrawFee(
      oraclePk,
      allocator,
      b,
      WithdrawFeePayment("relay", abi.encodePacked(spenderB), b.currency, 12),
      block.timestamp + 1 hours
    );
    vm.prank(spenderA);
    bytes32 hashA = allocator.submitWithdrawRequest(a, authA);
    vm.prank(spenderB);
    bytes32 hashB = allocator.submitWithdrawRequest(b, authB);

    assertTrue(
      allocator.hashesToSign(hashA, 0) != allocator.hashesToSign(hashB, 0)
    );
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
