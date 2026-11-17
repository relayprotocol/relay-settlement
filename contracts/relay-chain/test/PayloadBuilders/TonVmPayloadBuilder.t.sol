// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {buildPayloadOnly} from "../utils/Payload.sol";
import {signWithdrawFee} from "../utils/WithdrawFeeSig.sol";
import {
  IWithdrawalCounter,
  RelayAllocator,
  WithdrawRequest,
  WithdrawFee,
  WithdrawFeePayment,
  WithdrawFeePaymentAuthorization
} from "../../contracts/RelayAllocator.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
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
    allocator = new RelayAllocator(owner, address(hub), oracle);
    config = new Config(address(allocator));
    payloadBuilder = new TonVmPayloadBuilder(
      address(config),
      address(this),
      CHAIN_ID,
      SUBWALLET_ID,
      TIMEOUT
    );

    spender = makeAddr("spender");
    spenderAlias = Utils.generateAddress(CHAIN_ID, abi.encodePacked(spender));
    gasTokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, owner);
    vm.stopPrank();

    _setPayloadBuilderGasFee(GAS_FEE_AMOUNT);

    // Builder tests call buildPayload directly, so this contract stands in for the allocator
    _mockWithdrawalsThisSecond(0);
  }

  function _mockWithdrawalsThisSecond(uint256 count) internal {
    vm.mockCall(
      address(this),
      abi.encodeWithSelector(IWithdrawalCounter.withdrawalsThisSecond.selector),
      abi.encode(count)
    );
  }

  function _setRequestContext(
    bytes memory depository,
    WithdrawRequest memory params
  ) internal view {
    params.chainId = CHAIN_ID;
    params.depository = depository;
    params.spenderChainId = CHAIN_ID;
    params.spender = abi.encodePacked(spender);
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

  /// @notice Mirrors `_computeQueryId`: the withdrawal's index in the 4 * TIMEOUT
  /// period, split into shift and a bit_number below 1023
  function _expectedQueryId(
    uint256 timestamp,
    uint256 count
  ) internal pure returns (uint32) {
    uint256 period = uint256(TIMEOUT) * 4;
    uint256 perSecond = (8192 * 1023) / period;
    uint256 index = (timestamp % period) * perSecond + count;
    return uint32(((index / 1023) << 10) | (index % 1023));
  }
}

contract TonVmPayloadBuilderImmutablesTest is TonVmPayloadBuilderBase {
  function test_storesSubwalletId() public view {
    assertEq(uint256(payloadBuilder.SUBWALLET_ID()), uint256(SUBWALLET_ID));
  }

  function test_storesTimeout() public view {
    assertEq(uint256(payloadBuilder.TIMEOUT()), uint256(TIMEOUT));
  }

  function test_storesAllocatorAndChainId() public view {
    assertEq(payloadBuilder.ALLOCATOR(), address(this));
    assertEq(payloadBuilder.CHAIN_ID_HASH(), keccak256(bytes(CHAIN_ID)));
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

  function test_derivesQueryIdPeriodFromTimeout() public view {
    assertEq(payloadBuilder.QUERY_ID_PERIOD(), 14400);
    assertEq(payloadBuilder.QUERY_IDS_PER_SECOND(), 581);
  }

  function test_acceptsLongestTimeoutWithAQueryIdPerSecond() public {
    uint32 maxTimeout = (8192 * 1023) / 4;
    TonVmPayloadBuilder b = new TonVmPayloadBuilder(
      address(config),
      address(this),
      CHAIN_ID,
      SUBWALLET_ID,
      maxTimeout
    );
    assertEq(uint256(b.TIMEOUT()), uint256(maxTimeout));
    assertEq(b.QUERY_IDS_PER_SECOND(), 1);
  }

  function test_rejectsTimeoutWithoutAQueryIdPerSecond() public {
    uint32 tooLong = (8192 * 1023) / 4 + 1;
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidTimeout.selector,
        tooLong
      )
    );
    new TonVmPayloadBuilder(
      address(config),
      address(this),
      CHAIN_ID,
      SUBWALLET_ID,
      tooLong
    );
  }

  function test_rejectsZeroAllocator() public {
    vm.expectRevert(TonVmPayloadBuilder.ZeroAllocator.selector);
    new TonVmPayloadBuilder(
      address(config),
      address(0),
      CHAIN_ID,
      SUBWALLET_ID,
      TIMEOUT
    );
  }

  function test_rejectsZeroTimeout() public {
    vm.expectRevert(
      abi.encodeWithSelector(TonVmPayloadBuilder.InvalidTimeout.selector, 0)
    );
    new TonVmPayloadBuilder(
      address(config),
      address(this),
      CHAIN_ID,
      SUBWALLET_ID,
      0
    );
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
      address(this),
      CHAIN_ID,
      SUBWALLET_ID,
      tooLarge
    );
  }
}

contract TonVmPayloadBuilderBuildPayloadTest is TonVmPayloadBuilderBase {
  uint256 internal buildNonce;

  function test_rejectsReceiverWithInvalidLength() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: "",
      amount: 100,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: hex"1234",
      data: "",
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsEmptyCurrency() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: "",
      amount: 100,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(0)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsCurrencyWithInvalidLength() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: hex"00",
      amount: 100,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(1)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsNonNativeCurrency() public {
    bytes32 jetton = RECIPIENT_HASH;
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: abi.encodePacked(jetton),
      amount: 100,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.UnsupportedCurrency.selector,
        jetton
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsAmountAboveVarUInt16Max() public {
    uint256 tooLarge = uint256(1) << 120;
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: NATIVE_CURRENCY,
      amount: tooLarge,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(uint256(0))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.AmountExceedsMaxCoins.selector,
        tooLarge
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_buildsPayloadForNativeTon() public {
    uint256 nowTs = block.timestamp;
    uint256 nonceInput = 42;
    uint256 amount = 100000000;

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: NATIVE_CURRENCY,
      amount: amount,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(uint256(nonceInput))
    });
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
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

    uint32 expectedQueryId = _expectedQueryId(nowTs, 0);
    assertEq(uint256(request.queryId), uint256(expectedQueryId));
    // queryId must fit in 23 bits
    assertLt(uint256(request.queryId), uint256(1) << 23);
  }

  /// @notice Regression: index 1023 would read as bit_number 1023 if packed
  /// as a plain 23-bit number; the builder moves it to the next shift instead
  function test_neverUsesForbiddenBitNumber() public {
    vm.warp(14400 * 100_000 + 1);
    _mockWithdrawalsThisSecond(1023 - 581);
    assertEq(uint256(_buildQueryId()), uint256(1) << 10);
  }

  /// @notice Fuzz: no time or count produces `bit_number == 1023`
  function testFuzz_queryIdNeverHasForbiddenBitNumber(
    uint32 timestamp,
    uint256 count
  ) public {
    count = bound(count, 0, 580);
    vm.warp(timestamp);
    _mockWithdrawalsThisSecond(count);
    uint32 queryId = _buildQueryId();
    assertEq(uint256(queryId), uint256(_expectedQueryId(timestamp, count)));
    assertLt(uint256(queryId) & 0x3FF, 1023);
    assertLt(uint256(queryId), uint256(1) << 23);
  }

  /// @notice Hand-computed vectors at TIMEOUT 3600 (period 14400 s, 581 ids per second):
  /// index = (t % 14400) * 581 + count, queryId = (index / 1023) << 10 | index % 1023
  function test_matchesHandComputedQueryIds() public {
    // t=1: index 581 -> shift 0, bit 581
    _assertQueryIdAt(1, 0, 581);
    // t=14400 wraps to the period start: index 0
    _assertQueryIdAt(14400, 0, 0);
    // last slot of the period: index 8366399 -> shift 8178, bit 305
    _assertQueryIdAt(14399, 580, 8374577);
    // t=1e6 -> 6400 into the period: index 3718400 -> shift 3634, bit 818
    _assertQueryIdAt(1_000_000, 0, 3722034);
    _assertQueryIdAt(1_000_000, 1, 3722035);
    // next second starts 581 indexes later: 3718981 -> shift 3635, bit 376
    _assertQueryIdAt(1_000_001, 0, 3722616);
  }

  function test_rejectsCallerOtherThanTheAllocator() public {
    WithdrawRequest memory params = _request();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    address caller = otherAccounts[1];
    vm.prank(caller);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.CallerIsNotAllocator.selector,
        caller
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_rejectsAChainIdOtherThanTheBoundOne() public {
    WithdrawRequest memory params = _request();
    params.chainId = "ton-other";
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.UnexpectedChainId.selector,
        "ton-other"
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      "ton-other",
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function _assertQueryIdAt(
    uint256 timestamp,
    uint256 count,
    uint256 expected
  ) internal {
    vm.warp(timestamp);
    _mockWithdrawalsThisSecond(count);
    assertEq(uint256(_buildQueryId()), expected);
  }

  function _request() internal returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: _depositoryBytes(DEPOSITORY_HASH),
        currency: NATIVE_CURRENCY,
        amount: 100,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: abi.encodePacked(RECIPIENT_HASH),
        data: "",
        nonce: bytes32(++buildNonce)
      });
  }

  function _buildQueryId() internal returns (uint32) {
    WithdrawRequest memory params = _request();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    return
      abi
        .decode(
          buildPayloadOnly(
            payloadBuilder,
            CHAIN_ID,
            _depositoryBytes(DEPOSITORY_HASH),
            params
          ),
          (TonTransferRequest)
        )
        .queryId;
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

contract TonVmPayloadBuilderFeeTest is TonVmPayloadBuilderBase {
  function _updatePayloadBuilderGasFee(uint256 newAmount) internal {
    _setPayloadBuilderGasFee(newAmount);
  }

  function test_buildUsesUpdatedConfiguredFee() public {
    WithdrawRequest memory params = _params();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    _updatePayloadBuilderGasFee(GAS_FEE_AMOUNT / 2);
    (bytes memory payload, WithdrawFee memory fee) = payloadBuilder
      .buildPayload(CHAIN_ID, _depositoryBytes(DEPOSITORY_HASH), params);
    assertGt(payload.length, 0);
    assertEq(fee.currency, NATIVE_CURRENCY);
    assertEq(fee.amount, GAS_FEE_AMOUNT / 2);
  }

  function _params() internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: _depositoryBytes(DEPOSITORY_HASH),
        currency: NATIVE_CURRENCY,
        amount: 100000000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: abi.encodePacked(RECIPIENT_HASH),
        data: "",
        nonce: bytes32(uint256(42))
      });
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

/// @notice The Highload query id numbers the calling allocator's withdrawals of the chain
/// in the block second, so two withdrawals inside the wallet's replay window never share one
contract TonVmPayloadBuilderQueryIdTest is TonVmPayloadBuilderBase {
  function _params() internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: _depositoryBytes(DEPOSITORY_HASH),
        currency: NATIVE_CURRENCY,
        amount: 100000000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: abi.encodePacked(RECIPIENT_HASH),
        data: "",
        nonce: bytes32(uint256(42))
      });
  }

  function _queryId(
    WithdrawRequest memory params
  ) internal view returns (uint32) {
    return
      abi
        .decode(
          buildPayloadOnly(
            payloadBuilder,
            CHAIN_ID,
            _depositoryBytes(DEPOSITORY_HASH),
            params
          ),
          (TonTransferRequest)
        )
        .queryId;
  }

  function test_usesTheCallersWithdrawalCount() public {
    WithdrawRequest memory params = _params();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);

    _mockWithdrawalsThisSecond(7);
    assertEq(
      uint256(_queryId(params)),
      uint256(_expectedQueryId(block.timestamp, 7))
    );

    _mockWithdrawalsThisSecond(580);
    assertEq(
      uint256(_queryId(params)),
      uint256(_expectedQueryId(block.timestamp, 580))
    );
  }

  function test_revertsOnceTheSecondsQueryIdsAreUsed() public {
    WithdrawRequest memory params = _params();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);

    _mockWithdrawalsThisSecond(payloadBuilder.QUERY_IDS_PER_SECOND());
    vm.expectRevert(TonVmPayloadBuilder.QueryIdsExhausted.selector);
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  function test_revertsForACallerWithoutAWithdrawalCount() public {
    WithdrawRequest memory params = _params();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);
    vm.clearMockedCalls();

    vm.expectRevert();
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      params
    );
  }

  /// @notice Fuzz: two distinct (second, count) pairs less than 4 * TIMEOUT apart never
  /// share a query id
  function testFuzz_queryIdsAreUniqueWithinThePeriod(
    uint32 start,
    uint256 gap,
    uint256 firstCount,
    uint256 secondCount
  ) public {
    gap = bound(gap, 0, 14400 - 1);
    firstCount = bound(firstCount, 0, 580);
    secondCount = bound(secondCount, 0, 580);
    vm.assume(gap != 0 || firstCount != secondCount);

    WithdrawRequest memory params = _params();
    _setRequestContext(_depositoryBytes(DEPOSITORY_HASH), params);

    vm.warp(start);
    _mockWithdrawalsThisSecond(firstCount);
    uint32 first = _queryId(params);

    vm.warp(uint256(start) + gap);
    _mockWithdrawalsThisSecond(secondCount);
    uint32 second = _queryId(params);

    assertTrue(first != second);
  }
}

/// @notice VIG-PC-157: through the allocator, same-second TON withdrawals get consecutive
/// query ids, and one past the second's capacity reverts before anything is burned
contract TonVmPayloadBuilderAllocatorTest is TonVmPayloadBuilderBase {
  string internal constant SPENDER_CHAIN_ID = "relay";
  uint256 internal constant AMOUNT = 100000000;

  uint256 internal tokenId;
  TonVmPayloadBuilder internal allocatorBuilder;

  function setUp() public override {
    super.setUp();
    vm.clearMockedCalls();
    tokenId = Utils.generateTokenId(CHAIN_ID, NATIVE_CURRENCY);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(allocator));
    allocatorBuilder = _newAllocatorBuilder(TIMEOUT);
    _useBuilder(allocatorBuilder);
  }

  function test_givesSameSecondIdenticalRequestsDistinctQueryIds() public {
    address spenderB = otherAccounts[5];
    // Literal times: via-IR (coverage) re-reads a cached block.timestamp after vm.warp
    vm.warp(1_000_000);

    // Same receiver, amount and nonce from two spenders in one block
    uint32 first = _submit(spender, 42);
    uint32 second = _submit(spenderB, 42);
    // Hand-computed, see test_matchesHandComputedQueryIds
    assertEq(uint256(first), 3722034);
    assertEq(uint256(second), 3722035);

    vm.warp(1_000_001);
    assertEq(uint256(_submit(spender, 43)), 3722616);
  }

  /// @notice A second allocator sharing the builder (e.g. old and new during cutover)
  /// would count from zero in the same second, so the builder refuses it
  function test_rejectsAnAllocatorItIsNotBoundTo() public {
    RelayAllocator otherAllocator = new RelayAllocator(
      owner,
      address(hub),
      address(0xbeef)
    );
    vm.prank(owner);
    otherAllocator.setPayloadBuilder(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      address(allocatorBuilder)
    );

    WithdrawRequest memory request = _fundedRequest(spender, 1);
    vm.prank(spender);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.CallerIsNotAllocator.selector,
        address(otherAllocator)
      )
    );
    otherAllocator.submitWithdrawRequest(request);
  }

  /// @notice The allocator counts per chain id, so a builder registered under a
  /// second chain id would reuse the first chain's ids and is refused
  function test_rejectsAChainIdItIsNotBoundTo() public {
    vm.prank(owner);
    allocator.setPayloadBuilder(
      "ton-other",
      _depositoryBytes(DEPOSITORY_HASH),
      address(allocatorBuilder)
    );

    WithdrawRequest memory request = _fundedRequest(spender, 1);
    request.chainId = "ton-other";
    vm.prank(spender);
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.UnexpectedChainId.selector,
        "ton-other"
      )
    );
    allocator.submitWithdrawRequest(request);
  }

  function test_revertsPastTheSecondsCapacityWithoutBurning() public {
    TonVmPayloadBuilder oneIdPerSecond = _newAllocatorBuilder(
      (8192 * 1023) / 4
    );
    _useBuilder(oneIdPerSecond);
    bytes32 key = oneIdPerSecond.getGasFeeKey(CHAIN_ID);
    vm.prank(owner);
    config.setConfigValue(key, bytes32(GAS_FEE_AMOUNT));

    _submit(spender, 1);

    WithdrawRequest memory request = _fundedRequest(spender, 2);
    address alias_ = Utils.generateAddress(
      SPENDER_CHAIN_ID,
      abi.encodePacked(spender)
    );
    uint256 balance = hub.balanceOf(alias_, tokenId);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(request);
    vm.prank(spender);
    vm.expectRevert(TonVmPayloadBuilder.QueryIdsExhausted.selector);
    allocator.submitWithdrawRequest(request, authorization);
    assertEq(hub.balanceOf(alias_, tokenId), balance);

    vm.warp(block.timestamp + 1);
    vm.prank(spender);
    allocator.submitWithdrawRequest(request, authorization);
    assertEq(hub.balanceOf(alias_, tokenId), balance - AMOUNT - GAS_FEE_AMOUNT);
  }

  function _newAllocatorBuilder(
    uint32 timeout
  ) internal returns (TonVmPayloadBuilder) {
    return
      new TonVmPayloadBuilder(
        address(config),
        address(allocator),
        CHAIN_ID,
        SUBWALLET_ID,
        timeout
      );
  }

  function _useBuilder(TonVmPayloadBuilder builder) internal {
    vm.prank(owner);
    allocator.setPayloadBuilder(
      CHAIN_ID,
      _depositoryBytes(DEPOSITORY_HASH),
      address(builder)
    );
  }

  function _submit(address payer, uint256 nonce) internal returns (uint32) {
    WithdrawRequest memory request = _fundedRequest(payer, nonce);
    WithdrawFeePaymentAuthorization
      memory authorization = _withdrawFeePaymentAuthorization(request);
    vm.prank(payer);
    bytes32 requestHash = allocator.submitWithdrawRequest(
      request,
      authorization
    );
    return
      abi.decode(allocator.payloads(requestHash), (TonTransferRequest)).queryId;
  }

  /// @dev Funds the principal and the independently authorized fee debit
  function _fundedRequest(
    address payer,
    uint256 nonce
  ) internal returns (WithdrawRequest memory request) {
    request = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: _depositoryBytes(DEPOSITORY_HASH),
      currency: NATIVE_CURRENCY,
      amount: AMOUNT,
      spenderChainId: SPENDER_CHAIN_ID,
      spender: abi.encodePacked(payer),
      receiver: abi.encodePacked(RECIPIENT_HASH),
      data: "",
      nonce: bytes32(nonce)
    });
    address payerAlias = Utils.generateAddress(
      SPENDER_CHAIN_ID,
      abi.encodePacked(payer)
    );
    vm.prank(owner);
    hub.mint(payerAlias, tokenId, AMOUNT + GAS_FEE_AMOUNT);
  }

  function _withdrawFeePaymentAuthorization(
    WithdrawRequest memory request
  ) internal view returns (WithdrawFeePaymentAuthorization memory) {
    return
      signWithdrawFee(
        oraclePk,
        allocator,
        request,
        WithdrawFeePayment(
          request.spenderChainId,
          request.spender,
          NATIVE_CURRENCY,
          GAS_FEE_AMOUNT
        ),
        block.timestamp + 3600
      );
  }
}
