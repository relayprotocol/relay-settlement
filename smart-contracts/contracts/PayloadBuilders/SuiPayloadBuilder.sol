// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../Allocator.sol";
import {Utils} from "../Utils.sol";

/// @title SuiPayloadBuilder
/// @author Relay Protocol
/// @notice Builds BCS-encoded payloads for Sui chain withdrawals
contract SuiPayloadBuilder is IPayloadBuilder {
  error CoinTypeTooLong();
  error InvalidExpiration();

  /// @notice Builds BCS-encoded payload for Sui withdrawal
  /// @param currency Sui coin type (e.g., "0x2::sui::SUI")
  /// @param amount Amount to withdraw
  /// @param receiver Recipient address
  /// @param data Optional nonce and expiration (empty for defaults)
  /// @return BCS-encoded transaction payload
  function buildPayload(
    uint256 /* chainId */,
    string calldata /* depository */,
    string memory currency,
    uint256 amount,
    string memory receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    // Parse receiver address
    bytes32 recipientAddress = Utils.hexStringToBytes32(receiver);

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

    // Encode request in BCS-compatible format for Sui
    return encodeBCS(recipientAddress, currency, amountU64, nonce, expiration);
  }

  /// @notice Returns message hash to sign for Sui transaction
  /// @param payload BCS-encoded transaction payload
  /// @return hashes Array with single SHA256 hash
  function hashesToSign(
    uint256 /* chainId */,
    string calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    hashes = new bytes32[](1);
    hashes[0] = sha256(payload);
    return hashes;
  }

  /// @notice Returns cryptographic curve for Sui signing
  /// @return curve "Eddsa" for Sui
  function curve() external pure returns (string memory) {
    return "Eddsa";
  }

  /// @notice Returns blockchain family identifier
  /// @return family "sui-vm" for Sui
  function family() external pure returns (string memory) {
    return "sui-vm";
  }

  /// @notice Encodes Sui transaction payload in BCS format
  /// @param recipient Recipient address (32 bytes)
  /// @param coinType Sui coin type string (e.g., "0x2::sui::SUI")
  /// @param amount Amount to transfer
  /// @param nonce Unique transaction nonce
  /// @param expiration Expiration timestamp (seconds)
  /// @return BCS-encoded transaction payload
  function encodeBCS(
    bytes32 recipient,
    string memory coinType,
    uint64 amount,
    uint64 nonce,
    int64 expiration
  ) internal pure returns (bytes memory) {
    bytes memory result;

    // 1. Recipient address (32 bytes)
    result = bytes.concat(result, recipient);

    // 2. Amount (8 bytes) - using little-endian format as per BCS
    result = bytes.concat(result, Utils.encodeUint64LE(amount));

    // 3. Encode coin_type as TypeNameStruct
    bytes memory coinTypeBytes = bytes(coinType);

    // Add length of the string as a single byte if under 128 characters
    // For longer strings, BCS uses a different encoding scheme
    if (coinTypeBytes.length >= 128) revert CoinTypeTooLong();
    result = bytes.concat(result, bytes1(uint8(coinTypeBytes.length)));

    // Add the string data
    result = bytes.concat(result, coinTypeBytes);

    // 4. Nonce (8 bytes, little-endian)
    result = bytes.concat(result, Utils.encodeUint64LE(nonce));

    // 5. Expiration (8 bytes, little-endian)
    if (expiration < 0) revert InvalidExpiration();
    result = bytes.concat(result, Utils.encodeUint64LE(uint64(expiration)));

    return result;
  }
}
