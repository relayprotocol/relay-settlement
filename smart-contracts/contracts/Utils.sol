pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {JSONParserLib} from "solady/src/utils/JSONParserLib.sol";

/// @title Utils Library
/// @notice A utility library providing helper functions for cross-chain operations
/// @dev Contains functions for token ID generation, address generation, and data encoding
library Utils {
  /// @notice Generates a unique token ID based on blockchain family, chain ID, and token identifier
  /// @param family The blockchain family ('bitcoin-vm', 'ethereum-vm', 'solana-vm', 'sui-vm')
  /// @param chainId The ID of the blockchain network
  /// @param token The token address or identifier as a string
  /// @dev For EVM chains, the token string is parsed as an address. For non-EVM chains,
  /// the token string is used directly as an identifier.
  /// @return tokenId The token ID
  function generateTokenId(
    string memory family,
    uint256 chainId,
    string memory token
  ) external pure returns (uint256 tokenId) {
    if (Strings.equal(family, "ethereum-vm")) {
      return
        uint256(
          keccak256(
            abi.encodePacked(family, chainId, Strings.parseAddress(token))
          )
        );
    }
    return uint256(keccak256(abi.encodePacked(family, chainId, token)));
  }

  /// @notice Generates a virtual address for a given blockchain family, chain ID, and account
  /// @param family The blockchain family ('bitcoin-vm', 'ethereum-vm', 'solana-vm', 'sui-vm')
  /// @param chainId The ID of the blockchain network
  /// @param account The account address or identifier as a string
  /// @dev For EVM chains, the account string is parsed as an address. For non-EVM chains,
  /// the account string is used directly as an identifier.
  /// @return virtualAddress A virtual address derived from the input parameters
  function generateAddress(
    string memory family,
    uint256 chainId,
    string memory account
  ) external pure returns (address virtualAddress) {
    bytes32 addressHash = Strings.equal(family, "ethereum-vm")
      ? keccak256(
        abi.encodePacked(family, chainId, Strings.parseAddress(account))
      )
      : keccak256(abi.encodePacked(family, chainId, account));

    return address(uint160(uint256(addressHash)));
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
    for (uint8 i = 0; i < 8; i++) {
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
    for (uint8 i = 0; i < 4; i++) {
      b[i] = bytes1(uint8(value >> (8 * i)));
    }
    return b;
  }

  /// @notice Converts a hex string to bytes32
  /// @param s The hex string to convert (with or without '0x' prefix)
  /// @dev Accepts strings of exactly 64 hex characters or 66 characters with "0x" prefix.
  /// @return result The bytes32 representation of the input hex string
  function hexStringToBytes32(
    string memory s
  ) internal pure returns (bytes32 result) {
    // Parse the hex string to uint256 using Solady's parseUintFromHex
    uint256 parsed = JSONParserLib.parseUintFromHex(s);
    // Cast the uint256 to bytes32 and return
    return bytes32(parsed);
  }
}
