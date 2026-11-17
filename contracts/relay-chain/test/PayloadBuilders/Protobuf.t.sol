// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Protobuf} from "../../contracts/payload-builders/utils/Protobuf.sol";

/// @notice External wrapper, so reverts from the inlined library surface
/// through a real call for `vm.expectRevert`.
contract ProtobufHarness {
  function tag(
    uint8 fieldNumber,
    uint8 wireType
  ) external pure returns (bytes1) {
    return Protobuf.tag(fieldNumber, wireType);
  }
}

/// @notice Unit tests for the protobuf writer backing `HederaVmPayloadBuilder`.
/// The vectors are the encodings the protobuf specification defines, so a
/// change here means serialized Hedera bodies would stop matching what the
/// network and the Hedera SDK expect.
contract ProtobufTest is BaseTest {
  function test_varintEncodesSingleByteValues() public pure {
    assertEq(Protobuf.varint(0), hex"00");
    assertEq(Protobuf.varint(1), hex"01");
    assertEq(Protobuf.varint(127), hex"7f");
  }

  function test_varintEncodesMultiByteValues() public pure {
    assertEq(Protobuf.varint(128), hex"8001");
    assertEq(Protobuf.varint(300), hex"ac02");
    // Native Hedera USDC's entity number, as it appears in a token transfer.
    assertEq(Protobuf.varint(456858), hex"9af11b");
  }

  function test_varintEncodesBoundaries() public pure {
    // Largest signed 64-bit value: 9 bytes.
    assertEq(Protobuf.varint(uint64(type(int64).max)), hex"ffffffffffffffff7f");
    // Largest unsigned 64-bit value: the full 10 bytes.
    assertEq(Protobuf.varint(type(uint64).max), hex"ffffffffffffffffff01");
  }

  function test_varintRoundTripsThroughManualDecode() public pure {
    uint64[6] memory values = [
      uint64(0),
      1,
      127,
      128,
      456858,
      type(uint64).max
    ];
    for (uint256 i = 0; i < values.length; i++) {
      assertEq(_decodeVarint(Protobuf.varint(values[i])), values[i]);
    }
  }

  function testFuzz_varintRoundTrips(uint64 value) public pure {
    assertEq(_decodeVarint(Protobuf.varint(value)), value);
  }

  function test_zigzagEncodesSmallValues() public pure {
    assertEq(uint256(Protobuf.zigzag(0)), 0);
    assertEq(uint256(Protobuf.zigzag(-1)), 1);
    assertEq(uint256(Protobuf.zigzag(1)), 2);
    assertEq(uint256(Protobuf.zigzag(-2)), 3);
    assertEq(uint256(Protobuf.zigzag(2)), 4);
  }

  function test_zigzagEncodesTransferAmounts() public pure {
    // The debit and credit of a 5 HBAR transfer, in tinybars.
    assertEq(uint256(Protobuf.zigzag(-500000000)), 999999999);
    assertEq(uint256(Protobuf.zigzag(500000000)), 1000000000);
  }

  function test_zigzagEncodesBoundaries() public pure {
    assertEq(
      uint256(Protobuf.zigzag(type(int64).max)),
      uint256(type(uint64).max) - 1
    );
    assertEq(
      uint256(Protobuf.zigzag(type(int64).min)),
      uint256(type(uint64).max)
    );
  }

  function testFuzz_zigzagIsInjectiveAroundZero(int64 value) public pure {
    vm.assume(value != type(int64).min);
    assertTrue(Protobuf.zigzag(value) != Protobuf.zigzag(-value) || value == 0);
  }

  function test_tagPacksFieldNumberAndWireType() public pure {
    // Field 1, length-delimited: the transaction id's tag.
    assertEq(Protobuf.tag(1, Protobuf.WIRE_LENGTH_DELIMITED), bytes1(0x0a));
    // Field 3, varint: the transaction fee's tag.
    assertEq(Protobuf.tag(3, Protobuf.WIRE_VARINT), bytes1(0x18));
    // Field 14, length-delimited: the crypto transfer's tag.
    assertEq(Protobuf.tag(14, Protobuf.WIRE_LENGTH_DELIMITED), bytes1(0x72));
  }

  function test_tagRejectsFieldNumbersNeedingMoreThanOneByte() public {
    ProtobufHarness harness = new ProtobufHarness();
    vm.expectRevert(
      abi.encodeWithSelector(Protobuf.FieldNumberTooLarge.selector, uint256(16))
    );
    harness.tag(16, Protobuf.WIRE_VARINT);
  }

  function test_embeddedPrefixesTagAndLength() public pure {
    assertEq(Protobuf.embedded(1, hex"0102"), hex"0a020102");
    // An empty message still writes its tag and a zero length, which is how the
    // Hedera SDK encodes an empty memo.
    assertEq(Protobuf.embedded(6, new bytes(0)), hex"3200");
  }

  function test_embeddedHandlesMultiByteLengths() public pure {
    bytes memory message = new bytes(130);
    bytes memory encoded = Protobuf.embedded(1, message);
    // Tag, then a two-byte length varint, then the payload.
    assertEq(encoded.length, 1 + 2 + 130);
    assertEq(encoded[0], bytes1(0x0a));
    assertEq(encoded[1], bytes1(0x82));
    assertEq(encoded[2], bytes1(0x01));
  }

  /// @notice Minimal varint reader, so the encoder is checked against something
  /// other than itself.
  function _decodeVarint(bytes memory data) internal pure returns (uint64) {
    uint64 value = 0;
    uint256 shift = 0;
    for (uint256 i = 0; i < data.length; i++) {
      uint8 byte_ = uint8(data[i]);
      value |= uint64(byte_ & 0x7f) << shift;
      if (byte_ & 0x80 == 0) {
        return value;
      }
      shift += 7;
    }
    revert("truncated varint");
  }
}
