// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ChainSignatures
/// @author Relay Protocol
/// @notice Library for encoding JSON requests for chain signatures
library ChainSignatures {
  /// @notice Encodes a JSON request for the signer
  /// @param payloadHashToSign The hash of the payload to sign
  /// @param curve The curve to use for signing
  /// @param domainId The domain ID
  /// @return The encoded JSON request
  function encodeJSONRequest(
    bytes32 payloadHashToSign,
    string memory curve,
    string memory signerPath,
    string memory domainId
  ) public pure returns (bytes memory) {
    return
      abi.encodePacked(
        // solhint-disable-next-line quotes
        '{"request":{"payload_v2": { "',
        curve,
        // solhint-disable-next-line quotes
        '":"',
        stringifyBytes(payloadHashToSign),
        // solhint-disable-next-line quotes
        '"},"path":"',
        signerPath,
        // solhint-disable-next-line quotes
        '","domain_id":',
        domainId,
        // solhint-disable-next-line quotes
        "}}"
      );
  }

  /// @notice Converts a bytes32 value to its string representation
  /// @param hexBytes The bytes32 value to convert
  /// @return The string representation of the bytes32 value
  function stringifyBytes(
    bytes32 hexBytes
  ) public pure returns (string memory) {
    bytes16 alphabet = 0x30313233343536373839616263646566; // "0123456789abcdef"
    bytes memory str = new bytes(64);
    for (uint256 i = 0; i < 32; ) {
      uint8 b = uint8(hexBytes[i]);
      // precompute offset
      uint256 offset = i << 1; // i * 2
      str[offset] = alphabet[b >> 4]; // high nibble
      str[offset + 1] = alphabet[b & 0x0f]; // low nibble
      unchecked {
        i++;
      }
    }
    return string(str);
  }
}
