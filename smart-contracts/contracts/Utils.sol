// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Utils Library
/// @author Relay Protocol
/// @notice A utility library providing helper functions for cross-chain operations
/// @dev Contains functions for token id generation, address generation, and data encoding
library Utils {
  /// @notice Generates a unique token id based on chain id and token identifier
  /// @param chainId The id of the blockchain network
  /// @param token The token address or identifier
  /// @return tokenId The token id
  function generateTokenId(
    string memory chainId,
    bytes memory token
  ) external pure returns (uint256 tokenId) {
    return uint256(keccak256(abi.encodePacked(chainId, token)));
  }

  /// @notice Generates a virtual address for a given chain id and encoded account
  /// @param chainId The id of the blockchain network
  /// @param account The encoded account address or identifier
  /// @return virtualAddress A virtual address derived from the input parameters
  function generateAddress(
    string memory chainId,
    bytes memory account
  ) external pure returns (address virtualAddress) {
    return
      address(uint160(uint256(keccak256(abi.encodePacked(chainId, account)))));
  }

  /// @notice Builds an EIP-712 domain separator
  /// @param name The domain name
  /// @param version The domain version
  /// @param chainId The chain ID
  /// @param verifyingContract The verifying contract address
  /// @return domainSeparator The EIP-712 domain separator
  function buildDomainSeparator(
    string memory name,
    string memory version,
    uint256 chainId,
    address verifyingContract
  ) internal pure returns (bytes32 domainSeparator) {
    return
      keccak256(
        abi.encode(
          keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
          ),
          keccak256(bytes(name)),
          keccak256(bytes(version)),
          chainId,
          verifyingContract
        )
      );
  }

  /// @notice Converts a uint64 value to a byte array in little-endian format
  /// @param value The uint64 value to convert
  /// @dev Each byte of the output represents 8 bits of the input value, starting from the least significant bits.
  /// The result is a 8-byte array where the least significant byte comes first.
  /// @return encodedBytes A byte array representing the value in little-endian format
  function encodeUint64LE(
    uint64 value
  ) internal pure returns (bytes memory encodedBytes) {
    bytes memory b = new bytes(8);
    for (uint8 i = 0; i < 8; ++i) {
      b[i] = bytes1(uint8(value >> (8 * i)));
    }
    return b;
  }

  /// @notice Converts a uint32 value to a byte array in little-endian format
  /// @param value The uint32 value to convert
  /// @dev Each byte of the output represents 8 bits of the input value, starting from the least significant bits.
  /// The result is a 4-byte array where the least significant byte comes first.
  /// @return encodedBytes A byte array representing the value in little-endian format
  function encodeUint32LE(
    uint32 value
  ) internal pure returns (bytes memory encodedBytes) {
    bytes memory b = new bytes(4);
    for (uint8 i = 0; i < 4; ++i) {
      b[i] = bytes1(uint8(value >> (8 * i)));
    }
    return b;
  }
}
