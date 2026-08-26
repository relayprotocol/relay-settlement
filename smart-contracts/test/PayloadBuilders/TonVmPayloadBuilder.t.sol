// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {PayGasSig} from "../utils/PayGasSig.sol";
import {
  RelayAllocator,
  BuildPayloadParams
} from "../../contracts/RelayAllocator.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";
import {GasPaidPayloadBuilder} from "../../contracts/payload-builders/GasPaidPayloadBuilder.sol";
import {
  TonVmPayloadBuilder,
  TonTransferRequest
} from "../../contracts/payload-builders/TonVmPayloadBuilder.sol";

// Reference msg_inner cell hashes were computed using the @ton/core cell
// builder against the canonical Highload V3 layout — see
// tools/ton-reference-hashes.ts for the generation procedure.
abstract contract TonVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "ton-testnet";
  uint32 internal constant SUBWALLET_ID = 0x10AD0001;
  uint32 internal constant TIMEOUT = 3600;

  bytes32 internal constant ZERO_HASH = bytes32(0);

  /// @notice Encoded native TON currency: the 32-byte all-zero address hash,
  /// matching `encodeAddress(getVmTypeNativeCurrency("ton-vm"), "ton-vm")`.
  bytes internal constant NATIVE_CURRENCY =
    hex"0000000000000000000000000000000000000000000000000000000000000000";

  bytes32 internal constant RECIPIENT_HASH =
    0x1122334455667788990011223344556677889900112233445566778899001122;
  bytes32 internal constant DEPOSITORY_HASH =
    0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899;

  uint256 internal constant GAS_FEE_AMOUNT = 1000000000; // 1 TON in nanotons

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  WithdrawGasPayer internal gasPayer;
  TonVmPayloadBuilder internal payloadBuilder;

  address internal spender;
  address internal spenderAlias;
  uint256 internal gasTokenId;

  address internal oracle;
  uint256 internal oraclePk;

  function setUp() public virtual override {
    super.setUp();

    (oracle, oraclePk) = makeAddrAndKey("oracle");

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    gasPayer = new WithdrawGasPayer(address(hub), oracle);
    payloadBuilder = new TonVmPayloadBuilder(
      address(config),
      SUBWALLET_ID,
      TIMEOUT,
      address(gasPayer)
    );

    spender = makeAddr("spender");
    spenderAlias = Utils.generateAddress(CHAIN_ID, abi.encodePacked(spender));
    gasTokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, owner);
    hub.grantRole(operatorRole, address(gasPayer));
    vm.stopPrank();

    _setPayloadBuilderGasFee(GAS_FEE_AMOUNT);
  }

  /// @notice Pays the gas fee for the exact parameters that will be passed to
  /// `buildPayload`, unlocking the gas payment gate. Mirrors the off-chain
  /// flow: the oracle signs the request and anyone submits the payment.
  function _payGas(
    bytes memory depository,
    BuildPayloadParams memory params
  ) internal {
    vm.prank(owner);
    hub.mint(spenderAlias, gasTokenId, GAS_FEE_AMOUNT);

    RelayAllocator.WithdrawRequest memory request = RelayAllocator
      .WithdrawRequest({
        chainId: CHAIN_ID,
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
      GAS_FEE_AMOUNT,
      PayGasSig.sign(
        oraclePk,
        gasPayer,
        request,
        NATIVE_CURRENCY,
        GAS_FEE_AMOUNT
      )
    );
  }

  function _depositoryBytes(
    bytes32 depository
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(depository);
  }

  function _setPayloadBuilderGasFee(uint256 amount) internal {
    bytes32 key = payloadBuilder.getGasFeeKey(CHAIN_ID);
    vm.prank(owner);
    config.setConfigValue(key, bytes32(amount));
  }

  function _expectedQueryId(
    uint256 blockNumber,
    uint256 nonce,
    bytes memory currency,
    bytes memory receiver,
    bytes memory data,
    uint256 amount
  ) internal pure returns (uint32) {
    uint32 raw = uint32(
      uint256(
        keccak256(
          abi.encode(blockNumber, nonce, currency, receiver, data, amount)
        )
      )
    ) & uint32((uint32(1) << 23) - 1);
    if ((raw & 0x3FF) == 1023) {
      raw &= uint32(~uint32(0x3FF));
    }
    return raw;
  }
}

contract TonVmPayloadBuilderImmutablesTest is TonVmPayloadBuilderBase {
  function test_storesSubwalletId() public view {
    assertEq(uint256(payloadBuilder.SUBWALLET_ID()), uint256(SUBWALLET_ID));
  }

  function test_storesTimeout() public view {
    assertEq(uint256(payloadBuilder.TIMEOUT()), uint256(TIMEOUT));
  }

  function test_storesGasPayer() public view {
    assertEq(payloadBuilder.GAS_PAYER(), address(gasPayer));
  }

  function test_storesConfig() public view {
    assertEq(address(payloadBuilder.CONFIG()), address(config));
  }

  function test_gasFeeKeyMatchesDerivation() public view {
    assertEq(
      payloadBuilder.getGasFeeKey(CHAIN_ID),
      keccak256(
        abi.encodePacked(
          keccak256("TON_VM_GAS_FEE"),
          keccak256(bytes(CHAIN_ID))
        )
      )
    );
  }

  function test_acceptsMaxValid22BitTimeout() public {
    uint32 maxTimeout = uint32((uint32(1) << 22) - 1);
    TonVmPayloadBuilder b = new TonVmPayloadBuilder(
      address(config),
      SUBWALLET_ID,
      maxTimeout,
      address(gasPayer)
    );
    assertEq(uint256(b.TIMEOUT()), uint256(maxTimeout));
  }

  function test_rejectsTimeoutThatDoesNotFitIn22Bits() public {
    uint32 tooLarge = uint32(uint32(1) << 22);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.TimeoutExceeds22Bits.selector,
        tooLarge
      )
    );
    new TonVmPayloadBuilder(
      address(config),
      SUBWALLET_ID,
      tooLarge,
      address(gasPayer)
    );
  }
}

contract TonVmPayloadBuilderBuildPayloadTest is TonVmPayloadBuilderBase {
  function test_rejectsReceiverWithInvalidLength() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: "",
      amount: 100,
      receiver: hex"1234",
      nonce: 0,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsEmptyCurrency() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: "",
      amount: 100,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(0)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsCurrencyWithInvalidLength() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: hex"00",
      amount: 100,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(1)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsNonNativeCurrency() public {
    bytes32 jetton = RECIPIENT_HASH;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: abi.encodePacked(jetton),
      amount: 100,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.UnsupportedCurrency.selector,
        jetton
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsAmountAboveVarUInt16Max() public {
    uint256 tooLarge = uint256(1) << 120;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: tooLarge,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.AmountExceedsMaxCoins.selector,
        tooLarge
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_buildsPayloadForNativeTon() public {
    uint256 blockNumber = block.number;
    uint256 nowTs = block.timestamp;
    uint256 nonceInput = 42;
    uint256 amount = 100000000;

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: amount,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: nonceInput,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );

    TonTransferRequest memory request = abi.decode(
      payload,
      (TonTransferRequest)
    );
    assertEq(request.receiver, RECIPIENT_HASH);
    assertEq(uint256(request.amount), amount);
    assertEq(uint256(request.createdAt), nowTs);
    assertEq(uint256(request.subwalletId), uint256(SUBWALLET_ID));
    assertEq(uint256(request.timeout), uint256(TIMEOUT));

    uint32 expectedQueryId = _expectedQueryId(
      blockNumber,
      nonceInput,
      NATIVE_CURRENCY,
      abi.encodePacked(RECIPIENT_HASH),
      "",
      amount
    );
    assertEq(uint256(request.queryId), uint256(expectedQueryId));
    // queryId must fit in 23 bits
    assertLt(uint256(request.queryId), uint256(1) << 23);
  }

  /// @notice Regression: brute-force a nonce whose pre-remap keccak yields
  /// `bit_number == 1023` and confirm the builder remaps to a value the
  /// Highload V3 wallet will accept.
  function test_remapsForbiddenBitNumber() public {
    bytes memory receiver = abi.encodePacked(RECIPIENT_HASH);
    uint256 amount = 100;

    uint256 badNonce = type(uint256).max;
    for (uint256 n = 0; n < 16384; n++) {
      uint256 h = uint256(
        keccak256(
          abi.encode(
            block.number,
            n,
            NATIVE_CURRENCY,
            receiver,
            bytes(""),
            amount
          )
        )
      );
      if ((h & 0x3FF) == 1023) {
        badNonce = n;
        break;
      }
    }
    require(badNonce != type(uint256).max, "preimage not found in budget");

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: amount,
      receiver: receiver,
      nonce: badNonce,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
    TonTransferRequest memory request = abi.decode(
      payload,
      (TonTransferRequest)
    );
    // The raw keccak gave bit_number = 1023; the builder must remap it.
    assertLt(uint256(request.queryId) & 0x3FF, 1023);
    // And the shift bits should be preserved as-is.
    uint256 expectedShift = uint256(
      keccak256(
        abi.encode(
          block.number,
          badNonce,
          NATIVE_CURRENCY,
          receiver,
          bytes(""),
          amount
        )
      )
    ) >> 10;
    expectedShift &= 0x1FFF;
    assertEq(uint256(request.queryId) >> 10, expectedShift);
  }

  /// @notice Fuzz: no input should ever produce `bit_number == 1023`.
  function testFuzz_queryIdNeverHasForbiddenBitNumber(
    uint256 nonce,
    bytes32 receiver,
    uint120 amount
  ) public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: NATIVE_CURRENCY,
      amount: uint256(amount),
      receiver: abi.encodePacked(receiver),
      nonce: nonce,
      data: ""
    });
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);
    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
    TonTransferRequest memory request = abi.decode(
      payload,
      (TonTransferRequest)
    );
    assertLt(uint256(request.queryId) & 0x3FF, 1023);
    assertLt(uint256(request.queryId), uint256(1) << 23);
  }
}

contract TonVmPayloadBuilderHashesToSignTest is TonVmPayloadBuilderBase {
  /// @notice Reference vector V1: receiver=0, amount=0, queryId=0,
  /// createdAt=1700000000.
  function test_matchesReferenceHash_zeroFields() public view {
    TonTransferRequest memory request = TonTransferRequest({
      receiver: ZERO_HASH,
      amount: 0,
      createdAt: 1700000000,
      queryId: 0,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT
    });
    bytes memory payload = abi.encode(request);
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      payload
    );
    assertEq(hashes.length, 1);
    assertEq(
      hashes[0],
      bytes32(
        0xbcec9dc4ba69d5cd50b1d6d5a2f9639aec212c3eca5d1ee4185aa5eee6739dd5
      )
    );
  }

  /// @notice Reference vector V2: typical transfer (100 000 000 nanotons).
  function test_matchesReferenceHash_typicalTransfer() public view {
    TonTransferRequest memory request = TonTransferRequest({
      receiver: RECIPIENT_HASH,
      amount: 100000000,
      createdAt: 1735680000,
      queryId: 42,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT
    });
    bytes memory payload = abi.encode(request);
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      payload
    );
    assertEq(hashes.length, 1);
    assertEq(
      hashes[0],
      bytes32(
        0xdcb6f3ef5082435f374ab7c2ec0e5d7215321006fd2dbc9be2b32bbc28aea525
      )
    );
  }

  /// @notice Reference vector V3: amount at VarUInteger16 boundary
  /// (2^120 - 1), queryId at the largest *valid* value (2^23 - 2).
  /// @dev The truly-max 23-bit value (2^23 - 1) has bit_number = 1023, which
  /// Highload V3 rejects — `_computeQueryId` remaps that case. Picking
  /// 2^23 - 2 exercises shift = 2^13 - 1, bit_number = 1022 instead.
  function test_matchesReferenceHash_maxAmountAndMaxQueryId() public view {
    TonTransferRequest memory request = TonTransferRequest({
      receiver: RECIPIENT_HASH,
      amount: (uint128(1) << 120) - 1,
      createdAt: 2000000000,
      queryId: uint32((uint32(1) << 23) - 2),
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT
    });
    bytes memory payload = abi.encode(request);
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      payload
    );
    assertEq(hashes.length, 1);
    assertEq(
      hashes[0],
      bytes32(
        0x4fafc2989c0759db4e851e3d25603f5c982d01bc2831c507c687aec1c34d0507
      )
    );
  }

  function test_hashChangesWithEachField() public view {
    TonTransferRequest memory base = TonTransferRequest({
      receiver: RECIPIENT_HASH,
      amount: 1,
      createdAt: 1700000000,
      queryId: 1,
      subwalletId: SUBWALLET_ID,
      timeout: TIMEOUT
    });
    bytes32 baseHash = _hash(base);

    TonTransferRequest memory v;

    v = base;
    v.receiver = bytes32(uint256(base.receiver) ^ 1);
    assertTrue(_hash(v) != baseHash);

    v = base;
    v.amount = base.amount + 1;
    assertTrue(_hash(v) != baseHash);

    v = base;
    v.createdAt = base.createdAt + 1;
    assertTrue(_hash(v) != baseHash);

    v = base;
    v.queryId = base.queryId + 1;
    assertTrue(_hash(v) != baseHash);

    v = base;
    v.subwalletId = base.subwalletId + 1;
    assertTrue(_hash(v) != baseHash);

    v = base;
    v.timeout = base.timeout + 1;
    assertTrue(_hash(v) != baseHash);
  }

  function _hash(TonTransferRequest memory r) internal view returns (bytes32) {
    return
      payloadBuilder.hashesToSign(
        CHAIN_ID,
        _depositoryBytes(DEPOSITORY_HASH),
        abi.encode(r)
      )[0];
  }
}

contract TonVmPayloadBuilderGasPaymentTest is TonVmPayloadBuilderBase {
  function _updatePayloadBuilderGasFee(uint256 newAmount) internal {
    _setPayloadBuilderGasFee(newAmount);
  }

  function test_rejectsBuildWhenFeeRaisedAfterPayment() public {
    BuildPayloadParams memory params = _params();
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);

    _updatePayloadBuilderGasFee(GAS_FEE_AMOUNT * 2);

    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.PaidGasBelowGasFee.selector,
        GAS_FEE_AMOUNT,
        GAS_FEE_AMOUNT * 2
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_allowsBuildWhenFeeLoweredAfterPayment() public {
    BuildPayloadParams memory params = _params();
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);

    _updatePayloadBuilderGasFee(GAS_FEE_AMOUNT / 2);

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
    assertGt(payload.length, 0);
  }

  function _params() internal pure returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: NATIVE_CURRENCY,
        amount: 100000000,
        receiver: abi.encodePacked(RECIPIENT_HASH),
        nonce: 42,
        data: ""
      });
  }

  function test_rejectsBuildWithoutGasPayment() public {
    BuildPayloadParams memory params = _params();
    bytes32 expectedHash = keccak256(
      abi.encode(CHAIN_ID, _depositoryBytes(DEPOSITORY_HASH), params)
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        expectedHash
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsBuildWhenGasPaidForDifferentParams() public {
    BuildPayloadParams memory paid = _params();
    _payGas(_depositoryBytes(DEPOSITORY_HASH), paid);

    BuildPayloadParams memory unpaid = _params();
    unpaid.nonce = paid.nonce + 1;
    bytes32 expectedHash = keccak256(
      abi.encode(CHAIN_ID, _depositoryBytes(DEPOSITORY_HASH), unpaid)
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        expectedHash
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      unpaid
    );
  }

  function test_rejectsBuildWhenGasPaidForDifferentDepository() public {
    BuildPayloadParams memory params = _params();
    _payGas(_depositoryBytes(DEPOSITORY_HASH), params);

    bytes memory otherDepository = _depositoryBytes(RECIPIENT_HASH);
    bytes32 expectedHash = keccak256(
      abi.encode(CHAIN_ID, otherDepository, params)
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        expectedHash
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, otherDepository, params);
  }
}

contract TonVmPayloadBuilderMetadataTest is TonVmPayloadBuilderBase {
  function test_returnsExpectedCurve() public view {
    assertEq(payloadBuilder.curve(), "Eddsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(payloadBuilder.family(), "ton-vm");
  }
}
