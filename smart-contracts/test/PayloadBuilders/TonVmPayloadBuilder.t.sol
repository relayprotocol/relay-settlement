// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {
  RelayAllocator,
  BuildPayloadParams
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  TonVmPayloadBuilder,
  TonTransferRequest
} from "../../contracts/payload-builders/TonVmPayloadBuilder.sol";

// Reference msg_inner cell hashes were computed using the @ton/core cell
// builder against the canonical Highload V3 layout — see
// tools/tonReferenceHashes.ts for the generation procedure.
abstract contract TonVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "ton-testnet";
  uint32 internal constant SUBWALLET_ID = 0x10AD0001;
  uint32 internal constant TIMEOUT = 3600;

  bytes32 internal constant ZERO_HASH = bytes32(0);
  bytes32 internal constant RECIPIENT_HASH =
    0x1122334455667788990011223344556677889900112233445566778899001122;
  bytes32 internal constant DEPOSITORY_HASH =
    0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  TonVmPayloadBuilder internal payloadBuilder;

  function setUp() public virtual override {
    super.setUp();

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    payloadBuilder = new TonVmPayloadBuilder(SUBWALLET_ID, TIMEOUT);
  }

  function _depositoryBytes(
    bytes32 depository
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(depository);
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

  function test_acceptsMaxValid22BitTimeout() public {
    uint32 maxTimeout = uint32((uint32(1) << 22) - 1);
    TonVmPayloadBuilder b = new TonVmPayloadBuilder(SUBWALLET_ID, maxTimeout);
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
    new TonVmPayloadBuilder(SUBWALLET_ID, tooLarge);
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

  function test_rejectsNonEmptyCurrency() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: hex"00",
      amount: 100,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
    vm.expectRevert(
      abi.encodeWithSelector(
        TonVmPayloadBuilder.UnsupportedCurrency.selector,
        uint256(1)
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
      currency: "",
      amount: tooLarge,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: 0,
      data: ""
    });
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

  function test_buildsPayloadForNativeTon() public view {
    uint256 blockNumber = block.number;
    uint256 nowTs = block.timestamp;
    uint256 nonceInput = 42;
    uint256 amount = 100000000;

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: "",
      amount: amount,
      receiver: abi.encodePacked(RECIPIENT_HASH),
      nonce: nonceInput,
      data: ""
    });
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
      "",
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
  function test_remapsForbiddenBitNumber() public view {
    bytes memory receiver = abi.encodePacked(RECIPIENT_HASH);
    uint256 amount = 100;

    uint256 badNonce = type(uint256).max;
    for (uint256 n = 0; n < 16384; n++) {
      uint256 h = uint256(
        keccak256(
          abi.encode(block.number, n, bytes(""), receiver, bytes(""), amount)
        )
      );
      if ((h & 0x3FF) == 1023) {
        badNonce = n;
        break;
      }
    }
    require(badNonce != type(uint256).max, "preimage not found in budget");

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: "",
      amount: amount,
      receiver: receiver,
      nonce: badNonce,
      data: ""
    });
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
          bytes(""),
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
  ) public view {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: "",
      amount: uint256(amount),
      receiver: abi.encodePacked(receiver),
      nonce: nonce,
      data: ""
    });
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

contract TonVmPayloadBuilderMetadataTest is TonVmPayloadBuilderBase {
  function test_returnsExpectedCurve() public view {
    assertEq(payloadBuilder.curve(), "Eddsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(payloadBuilder.family(), "ton-vm");
  }
}
