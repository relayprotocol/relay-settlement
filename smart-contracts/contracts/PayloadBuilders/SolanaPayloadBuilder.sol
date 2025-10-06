// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @title SolanaPayloadBuilder
/// @author Relay Protocol
/// @notice Builds Borsh-encoded payloads for Solana chain withdrawals
contract SolanaPayloadBuilder is IPayloadBuilder {
  error InvalidExpiration();

  /// @notice Builds Borsh-encoded payload for Solana withdrawal
  /// @param currency SPL token address (empty for SOL)
  /// @param amount Amount to withdraw
  /// @param receiver Recipient public key
  /// @param data Optional nonce and expiration (empty for defaults)
  /// @return Borsh-encoded transaction payload
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

  /// @notice Returns message hash to sign for Solana transaction
  /// @param payload Borsh-encoded transaction payload
  /// @return hashes Array with single SHA256 hash
  function hashToSign(
    uint256 /* chainId */,
    string calldata /* depository */,
    bytes calldata payload,
    uint32 /* hashIndex */
  ) external pure override returns (bytes32) {
    return sha256(payload);
  }

  /// @notice Returns cryptographic curve for Solana signing
  /// @return curve "Eddsa" for Solana
  function curve() external pure returns (string memory) {
    return "Eddsa";
  }

  /// @notice Returns blockchain family identifier
  /// @return family "solana-vm" for Solana
  function family() external pure returns (string memory) {
    return "solana-vm";
  }

  /// @notice Encodes Solana transaction payload in Borsh format
  /// @param recipient Recipient public key (32 bytes)
  /// @param token SPL token public key (zero for SOL)
  /// @param amount Amount to transfer
  /// @param nonce Unique transaction nonce
  /// @param expiration Expiration timestamp (seconds)
  /// @return Borsh-encoded transaction payload
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
    if (expiration < 0) revert InvalidExpiration();
    result = bytes.concat(result, Utils.encodeUint64LE(uint64(expiration)));

    return result;
  }

  /// @notice Converts hex string to bytes32 (for testing)
  /// @param hexString Hex string to convert
  /// @return bytes32 representation
  function hexStringToBytes32(
    string memory hexString
  ) public pure returns (bytes32) {
    return Utils.hexStringToBytes32(hexString);
  }
}
