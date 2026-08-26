// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Protobuf
/// @author Relay Protocol
/// @notice Minimal protocol-buffers writer, sufficient for serializing the
///         fixed-shape Hedera `TransactionBody` that `HederaVmPayloadBuilder`
///         signs. Only the encodings that body needs are implemented: varint
///         and length-delimited fields.
/// @dev The library only has internal functions, so it is inlined into the
///      calling contracts at compile time — it is never deployed or linked
///      separately.
///
///      Callers control which fields are emitted. Unlike a proto3 encoder that
///      elides default values, every helper here writes unconditionally: the
///      Hedera JavaScript SDK writes explicit zeros for the shard, realm,
///      `scheduled`, `is_approval` and memo fields, and matching its bytes
///      exactly is what lets an off-chain submitter and this contract agree on
///      the signed payload (see `HederaVmPayloadBuilder`).
library Protobuf {
  /// @notice Thrown when a field number does not fit a single-byte tag
  /// @param fieldNumber The offending field number
  error FieldNumberTooLarge(uint256 fieldNumber);

  /// @notice Wire type 0: varint-encoded integers
  uint8 internal constant WIRE_VARINT = 0;

  /// @notice Wire type 2: length-delimited bytes, strings and embedded messages
  uint8 internal constant WIRE_LENGTH_DELIMITED = 2;

  /// @notice Largest field number that still fits a single-byte tag
  uint8 internal constant MAX_SINGLE_BYTE_FIELD_NUMBER = 15;

  /// @notice Encodes a field tag (field number and wire type)
  /// @dev Every field of the Hedera transaction body written here has a field
  ///      number of 15 or less, so a tag is always a single byte. Larger field
  ///      numbers revert rather than silently truncating.
  /// @param fieldNumber The protobuf field number
  /// @param wireType The protobuf wire type
  /// @return The single-byte tag
  function tag(
    uint8 fieldNumber,
    uint8 wireType
  ) internal pure returns (bytes1) {
    if (fieldNumber > MAX_SINGLE_BYTE_FIELD_NUMBER) {
      revert FieldNumberTooLarge(fieldNumber);
    }
    return bytes1((fieldNumber << 3) | wireType);
  }

  /// @notice Encodes an unsigned integer as a base-128 varint
  /// @param value The value to encode
  /// @return out The varint bytes, 1 to 10 of them
  function varint(uint64 value) internal pure returns (bytes memory out) {
    // A uint64 varint is at most ceil(64 / 7) = 10 bytes.
    bytes memory buffer = new bytes(10);
    uint256 length = 0;
    while (value >= 0x80) {
      buffer[length++] = bytes1(uint8(value & 0x7f) | 0x80);
      value >>= 7;
    }
    buffer[length++] = bytes1(uint8(value));

    out = new bytes(length);
    for (uint256 i = 0; i < length; i++) {
      out[i] = buffer[i];
    }
  }

  /// @notice Maps a signed integer onto an unsigned one with zigzag encoding
  /// @dev This is what protobuf's `sint64` type uses, so that small negative
  ///      values stay short instead of sign-extending to a full 10-byte varint.
  ///      Hedera's `AccountAmount.amount` is a `sint64`.
  /// @param value The signed value
  /// @return The zigzag-encoded value
  function zigzag(int64 value) internal pure returns (uint64) {
    // (value << 1) ^ (value >> 63) in two's complement. Solidity shifts
    // truncate rather than revert, so the left shift wraps exactly as the
    // reference encoding requires, and the arithmetic right shift yields 0 for
    // non-negative values and -1 (all ones) for negative ones.
    return uint64(value << 1) ^ uint64(value >> 63);
  }

  /// @notice Encodes a varint field (tag and value)
  /// @param fieldNumber The protobuf field number
  /// @param value The value to encode
  /// @return The encoded field
  function varintField(
    uint8 fieldNumber,
    uint64 value
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(tag(fieldNumber, WIRE_VARINT), varint(value));
  }

  /// @notice Encodes a `sint64` field (tag and zigzag-encoded value)
  /// @param fieldNumber The protobuf field number
  /// @param value The signed value to encode
  /// @return The encoded field
  function sint64Field(
    uint8 fieldNumber,
    int64 value
  ) internal pure returns (bytes memory) {
    return varintField(fieldNumber, zigzag(value));
  }

  /// @notice Encodes a length-delimited field: an embedded message, byte string
  ///         or UTF-8 string, prefixed by its tag and length
  /// @param fieldNumber The protobuf field number
  /// @param message The already-serialized contents
  /// @return The encoded field
  function embedded(
    uint8 fieldNumber,
    bytes memory message
  ) internal pure returns (bytes memory) {
    return
      abi.encodePacked(
        tag(fieldNumber, WIRE_LENGTH_DELIMITED),
        varint(uint64(message.length)),
        message
      );
  }
}
