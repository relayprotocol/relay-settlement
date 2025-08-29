// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";
import {Utils} from "../Utils.sol";

contract SolanaPayloadBuilder is PayloadBuilder {
  function buildPayload(
    uint256 /* chainId */,
    string calldata /* depository */,
    string memory currency,
    uint256 amount,
    string memory receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    // Parse token address (None means SOL)
    bytes32 tokenPubkey;
    bytes32 recipientPubkey = Utils.hexStringToBytes32(receiver);

    if (bytes(currency).length > 0) {
      tokenPubkey = Utils.hexStringToBytes32(currency);
    }

    // Ensure amount doesn't exceed uint64 max value
    if (amount > type(uint64).max) {
      revert InsufficientAmount(amount);
    }

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
    string calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    hashes = new bytes32[](1);
    hashes[0] = sha256(payload);
    return hashes;
  }

  function curve() external pure returns (string memory) {
    return "Eddsa";
  }

  function family() external pure returns (string memory) {
    return "solana-vm";
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
    result = bytes.concat(result, Utils.encodeUint64LE(amount));

    // 4. Nonce (8 bytes, little-endian)
    result = bytes.concat(result, Utils.encodeUint64LE(nonce));

    // 5. Expiration (8 bytes, little-endian)
    require(expiration >= 0, "Expiration cannot be negative");
    result = bytes.concat(result, Utils.encodeUint64LE(uint64(expiration)));

    return result;
  }

  // For test
  function hexStringToBytes32(
    string memory hexString
  ) public pure returns (bytes32) {
    return Utils.hexStringToBytes32(hexString);
  }
}
