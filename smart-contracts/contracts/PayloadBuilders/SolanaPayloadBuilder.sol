// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @title IRelayAllocator
/// @notice Interface for RelayAllocator contract
// solhint-disable-next-line use-natspec
interface IRelayAllocator {
  /// @notice Returns the owner address of the RelayAllocator contract
  /// @return The address of the contract owner
  function owner() external view returns (address);
}

/// @notice Configuration for a specific chain
struct ChainConfig {
  bytes32 domain; /// @notice Domain separator for the chain
  bytes32 vaultAddress; /// @notice Vault address for the chain
}

/// @title SolanaPayloadBuilder
/// @author Relay Protocol
/// @notice Builds Borsh-encoded payloads for Solana chain withdrawals
contract SolanaPayloadBuilder is IPayloadBuilder {
  error InvalidExpiration();
  error NotRelayAllocatorOwner(address account);
  error ChainNotConfigured(uint256 chainId);

  /// @notice RelayAllocator contract instance
  IRelayAllocator public immutable allocator;

  /// @notice Chain configuration for each chain ID
  mapping(uint256 => ChainConfig) public chainConfigs;

  /// @notice Constructor that initializes the payload builder with allocator
  /// @param _allocator The RelayAllocator contract address
  constructor(IRelayAllocator _allocator) {
    allocator = _allocator;
  }

  /// @notice Modifier to restrict access to allocator owner only
  modifier onlyAllocatorOwner() {
    if (msg.sender != allocator.owner())
      revert NotRelayAllocatorOwner(msg.sender);
    _;
  }

  /// @notice Sets the chain configuration for a specific chain
  /// @param chainId The chain ID
  /// @param domain The domain separator (32 bytes)
  /// @param vaultAddress The vault address (32 bytes)
  function setChainConfig(
    uint256 chainId,
    bytes32 domain,
    bytes32 vaultAddress
  ) external onlyAllocatorOwner {
    chainConfigs[chainId] = ChainConfig({
      domain: domain,
      vaultAddress: vaultAddress
    });
  }

  /// @notice Builds Borsh-encoded payload for Solana withdrawal
  /// @param chainId Chain ID to get domain and vault configuration
  /// @param currency SPL token address (empty for SOL)
  /// @param amount Amount to withdraw
  /// @param receiver Recipient public key
  /// @param data Optional nonce and expiration (empty for defaults)
  /// @return Borsh-encoded transaction payload
  function buildPayload(
    uint256 chainId,
    string calldata /* depository */,
    string memory currency,
    uint256 amount,
    string memory receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    // Get chain configuration
    ChainConfig memory config = chainConfigs[chainId];
    if (config.vaultAddress == bytes32(0)) {
      revert ChainNotConfigured(chainId);
    }

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
      if (expiration < int64(int256(block.timestamp))) {
        revert InvalidExpiration();
      }
    }

    // Encode request in Borsh compatible format
    return
      encodeBorsh(
        config.domain,
        recipientPubkey,
        tokenPubkey,
        amountU64,
        nonce,
        expiration,
        config.vaultAddress
      );
  }

  /// @notice Returns message hash to sign for Solana transaction
  /// @param payload Borsh-encoded transaction payload
  /// @return SHA256 hash of the payload
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

  /// @notice Encodes Solana TransferRequest in Borsh format
  /// @dev Field order matches Rust struct:
  ///      1. domain, 2. recipient, 3. token, 4. amount, 5. nonce, 6. expiration, 7. vault_address
  /// @param domain Domain separator (32 bytes)
  /// @param recipient Recipient public key (32 bytes)
  /// @param token SPL token public key (zero for SOL)
  /// @param amount Amount to transfer (u64)
  /// @param nonce Unique transaction nonce (u64)
  /// @param expiration Expiration timestamp in seconds (i64)
  /// @param vaultAddress Vault address (32 bytes)
  /// @return Borsh-encoded TransferRequest payload
  function encodeBorsh(
    bytes32 domain,
    bytes32 recipient,
    bytes32 token,
    uint64 amount,
    uint64 nonce,
    int64 expiration,
    bytes32 vaultAddress
  ) internal pure returns (bytes memory) {
    bytes memory result;

    // 1. Domain (32 bytes)
    result = bytes.concat(result, domain);

    // 2. Recipient (32 bytes)
    result = bytes.concat(result, recipient);

    // 3. Token (Option<Pubkey>) - 1 byte discriminant + optional 32 bytes
    if (token == bytes32(0)) {
      // None (0x00) for native SOL
      result = bytes.concat(result, hex"00");
    } else {
      // Some (0x01) for SPL token
      result = bytes.concat(result, hex"01", token);
    }

    // 4. Amount (8 bytes, little-endian u64)
    result = bytes.concat(result, Utils.encodeUint64LE(amount));

    // 5. Nonce (8 bytes, little-endian u64)
    result = bytes.concat(result, Utils.encodeUint64LE(nonce));

    // 6. Expiration (8 bytes, little-endian i64)
    if (expiration < 0) revert InvalidExpiration();
    result = bytes.concat(result, Utils.encodeUint64LE(uint64(expiration)));

    // 7. Vault address (32 bytes)
    result = bytes.concat(result, vaultAddress);

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
