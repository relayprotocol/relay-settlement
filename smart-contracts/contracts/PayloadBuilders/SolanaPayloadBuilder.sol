// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";

contract SolanaPayloadBuilder is PayloadBuilder {
  function buildPayload(
    uint256 /* chainId */,
    string calldata /* escrow */,
    string memory currency,
    uint256 amount,
    string memory receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    // Parse token address (None means SOL)
    bytes32 tokenPubkey;
    bytes32 recipientPubkey = toBytes32(receiver);

    if (bytes(currency).length > 0) {
      tokenPubkey = toBytes32(currency);
    }

    // Ensure amount doesn't exceed uint64 max value
    require(amount <= type(uint64).max, "Amount exceeds uint64 max");
    uint64 amountU64 = uint64(amount);

    // Parse or generate nonce and expiration
    uint64 nonce;
    int64 expiration;

    if (data.length == 0) {
      // Generate default values if no data provided
      nonce = uint64(
        uint256(keccak256(abi.encodePacked(block.timestamp, block.number)))
      );
      expiration = int64(int256(block.timestamp + 300)); // 5 minutes validity
    } else {
      // Decode provided nonce and expiration
      (nonce, expiration) = abi.decode(data, (uint64, int64));
    }

    // Encode request in Borsh compatible format
    return
      encodeBorsh(recipientPubkey, tokenPubkey, amountU64, nonce, expiration);
  }

  function hashesToSign(
    uint256 /* chainId */,
    string calldata /* escrow */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    hashes = new bytes32[](1);
    hashes[0] = sha256(payload);
    return hashes;
  }

  function curve() external pure returns (string memory) {
    return "Eddsa";
  }

  function encodeBorsh(
    bytes32 recipient,
    bytes32 token,
    uint64 amount,
    uint64 nonce,
    int64 expiration
  ) internal pure returns (bytes memory) {
    bytes memory result;

    // 1. Recipient (32 bytes)
    result = bytes.concat(result, recipient);

    // 2. Token (Option<Pubkey>) - using 1 byte prefix
    if (token == bytes32(0)) {
      // None means SOL
      result = bytes.concat(result, hex"00");
    } else {
      // Some means SPL token
      result = bytes.concat(result, hex"01");
      result = bytes.concat(result, token);
    }

    // 3. Amount (8 bytes, little-endian)
    result = bytes.concat(result, toLE64(amount));

    // 4. Nonce (8 bytes, little-endian)
    result = bytes.concat(result, toLE64(nonce));

    // 5. Expiration (8 bytes, little-endian)
    require(expiration >= 0, "Expiration cannot be negative");
    result = bytes.concat(result, toLE64(uint64(expiration)));

    return result;
  }

  function toLE64(uint64 value) internal pure returns (bytes memory) {
    bytes memory result = new bytes(8);
    for (uint8 i = 0; i < 8; i++) {
      result[i] = bytes1(uint8(value >> (8 * i)));
    }
    return result;
  }

  function toBytes32(string memory s) public pure returns (bytes32) {
    bytes memory b = bytes(s);
    bool hasPrefix = b.length == 66 &&
      b[0] == "0" &&
      (b[1] == "x" || b[1] == "X");
    require(b.length == 64 || hasPrefix, "Invalid length");
    uint256 result = 0;
    uint256 offset = hasPrefix ? 2 : 0;
    for (uint256 i = offset; i < b.length; i++) {
      result <<= 4;
      uint8 c = uint8(b[i]);

      if (c >= 48 && c <= 57) {
        // 0-9
        result |= uint256(c - 48);
      } else if (c >= 65 && c <= 70) {
        // A-F
        result |= uint256(c - 55);
      } else if (c >= 97 && c <= 102) {
        // a-f
        result |= uint256(c - 87);
      } else {
        revert("Invalid character");
      }
    }
    return bytes32(result);
  }
}
