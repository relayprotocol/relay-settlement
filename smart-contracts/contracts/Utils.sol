pragma solidity ^0.8.28;
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {JSONParserLib} from "solady/src/utils/JSONParserLib.sol";

library Utils {
  /**
   * @notice Generates a unique ID for a  based on the family (type of chain), chain ID, and account
   * @param family The blockchain family ('evm', 'solana', 'bitcoin')
   * @param chainId The ID of the blockchain network
   * @param token The token address or identifier
   * @dev We pass the token as a string to support identifiers from non-EVM chains.
   * EVM-chains addresses are casted to address type.
   * @return A bytes32 hash representing the unique token ID
   */
  function generateTokenId(
    string memory family,
    uint256 chainId,
    string memory token
  ) external pure returns (uint256) {
    if (Strings.equal(family, "evm")) {
      return
        uint256(
          keccak256(
            abi.encodePacked(family, chainId, Strings.parseAddress(token))
          )
        );
    }
    return uint256(keccak256(abi.encodePacked(family, chainId, token)));
  }

  /**
   * @notice Generates a virtual address for a given family, chain ID, and account
   * @param family The blockchain family ('evm', 'solana', 'bitcoin')
   * @param chainId The ID of the blockchain network
   * @param account The account address or identifier
   * @return A virtual address derived from the token ID
   */
  function generateAddress(
    string memory family,
    uint256 chainId,
    string memory account
  ) external pure returns (address) {
    bytes32 addressHash = Strings.equal(family, "evm")
      ? keccak256(
        abi.encodePacked(family, chainId, Strings.parseAddress(account))
      )
      : keccak256(abi.encodePacked(family, chainId, account));

    return address(uint160(uint256(addressHash)));
  }

  /**
   * @notice Converts a uint64 value to a byte array in little-endian format
   * @param value The uint64 value to convert
   * @return A byte array representing the value in little-endian format (least significant byte first)
   * @dev Each byte of the output represents 8 bits of the input value, starting from the least significant bits
   */
  function encodeUint64LE(uint64 value) internal pure returns (bytes memory) {
    bytes memory b = new bytes(8);
    for (uint8 i = 0; i < 8; i++) {
      b[i] = bytes1(uint8(value >> (8 * i)));
    }
    return b;
  }

  /**
   * @notice Converts a uint32 value to a byte array in little-endian format
   * @param value The uint32 value to convert
   * @return A byte array representing the value in little-endian format (least significant byte first)
   * @dev Each byte of the output represents 8 bits of the input value, starting from the least significant bits
   */
  function encodeUint32LE(uint32 value) internal pure returns (bytes memory) {
    bytes memory b = new bytes(4);
    for (uint8 i = 0; i < 4; i++) {
      b[i] = bytes1(uint8(value >> (8 * i)));
    }
    return b;
  }

  /**
   * @notice Converts a hex string to bytes32
   * @param s The hex string to convert (with or without '0x' prefix)
   * @return The bytes32 representation of the input string
   * @dev Accepts strings of exactly 64 hex characters or 66 characters with "0x" prefix
   */
  function hexStringToBytes32(string memory s) internal pure returns (bytes32) {
    // Parse the hex string to uint256 using Solady's parseUintFromHex
    uint256 parsed = JSONParserLib.parseUintFromHex(s);
    // Cast the uint256 to bytes32 and return
    return bytes32(parsed);
  }
}
