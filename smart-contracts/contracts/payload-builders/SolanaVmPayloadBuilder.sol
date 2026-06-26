// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "../Config.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

struct TransferFields {
  bytes32 recipientPubkey;
  bytes32 tokenPubkey;
  uint64 amountU64;
}

/// @title SolanaVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "solana-vm" chains
contract SolanaVmPayloadBuilder is IPayloadBuilder {
  /// @notice Thrown when a provided value does not fit into uint64
  /// @param value Provided value
  error ValueExceedsUint64(uint256 value);

  /// @notice Thrown when an encoded address does not have the expected length
  /// @param length Actual encoded length
  /// @param expectedLength Expected encoded length
  error InvalidAddressLength(uint256 length, uint256 expectedLength);

  /// @notice Config contract used to resolve Solana chain metadata
  Config public immutable CONFIG;

  /// @notice Prefix used when deriving config keys for Solana VM domain lookups
  bytes32 internal constant SOLANA_VM_DOMAIN_PREFIX =
    keccak256("SOLANA_VM_DOMAIN");

  /// @notice Prefix used when deriving config keys for Solana VM vault address lookups
  bytes32 internal constant SOLANA_VM_VAULT_ADDRESS_PREFIX =
    keccak256("SOLANA_VM_VAULT_ADDRESS");

  /// @notice Prefix used when deriving config keys for Solana VM request expiration lookups
  bytes32 internal constant SOLANA_VM_EXPIRATION_PREFIX =
    keccak256("SOLANA_VM_EXPIRATION");

  /// @notice Creates a new Solana VM payload builder
  /// @param _config Config contract address
  constructor(address _config) {
    CONFIG = Config(_config);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Receiver and currency use the current address encoding scheme, which for Solana is the raw 32-byte public key.
  function buildPayload(
    string calldata chainId,
    bytes calldata /* depository */,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    (bytes32 domain, bytes32 vaultAddress) = getChainConfig(chainId);
    TransferFields memory fields = decodeTransferFields(
      params.currency,
      params.amount,
      params.receiver
    );
    int64 expiration = int64(int256(block.timestamp + getExpirationDelay()));

    return
      encodeBorsh(
        domain,
        fields.recipientPubkey,
        fields.tokenPubkey,
        fields.amountU64,
        computeNonce(params),
        expiration,
        vaultAddress
      );
  }

  /// @notice Returns the config key used to look up a Solana domain for a chain id
  /// @param chainId Chain id
  /// @return key Config key
  function getDomainKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(SOLANA_VM_DOMAIN_PREFIX, chainId));
  }

  /// @notice Returns the config key used to look up a Solana vault address for a chain id
  /// @param chainId Chain id
  /// @return key Config key
  function getVaultAddressKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(SOLANA_VM_VAULT_ADDRESS_PREFIX, chainId));
  }

  /// @notice Returns the config key used to look up the default Solana request expiration delay
  /// @return key Config key
  function getExpirationKey() public pure returns (bytes32 key) {
    return SOLANA_VM_EXPIRATION_PREFIX;
  }

  /// @notice Returns the configured Solana domain and vault address for a chain id
  /// @param chainId Chain id
  /// @return domain Configured Solana domain
  /// @return vaultAddress Configured Solana vault address
  function getChainConfig(
    string calldata chainId
  ) public view returns (bytes32 domain, bytes32 vaultAddress) {
    domain = CONFIG.getConfigValue(getDomainKey(chainId));
    vaultAddress = CONFIG.getConfigValue(getVaultAddressKey(chainId));
  }

  /// @notice Returns the configured default Solana request expiration delay in seconds
  /// @return expirationDelay Configured expiration delay
  function getExpirationDelay() public view returns (uint64 expirationDelay) {
    return uint64(uint256(CONFIG.getConfigValue(getExpirationKey())));
  }

  /// @notice Validates and decodes transfer fields from Solana address encoding
  /// @param currency Encoded currency address
  /// @param amount Requested amount
  /// @param receiver Encoded receiver address
  /// @return fields Decoded transfer fields
  function decodeTransferFields(
    bytes calldata currency,
    uint256 amount,
    bytes calldata receiver
  ) internal pure returns (TransferFields memory fields) {
    if (receiver.length != 32) {
      revert InvalidAddressLength(receiver.length, 32);
    }

    if (currency.length != 0 && currency.length != 32) {
      revert InvalidAddressLength(currency.length, 32);
    }

    if (amount > type(uint64).max) {
      revert ValueExceedsUint64(amount);
    }

    fields.recipientPubkey = bytes32(receiver);
    fields.tokenPubkey = currency.length == 32 ? bytes32(currency) : bytes32(0);
    fields.amountU64 = uint64(amount);
  }

  /// @notice Computes the request nonce from the block number and request-specific payload fields
  /// @param params Payload builder parameters supplied by the allocator
  /// @return nonce Derived request nonce truncated to uint64 for Solana payloads
  function computeNonce(
    BuildPayloadParams calldata params
  ) internal view returns (uint64 nonce) {
    nonce = uint64(
      uint256(
        keccak256(
          abi.encode(
            block.number,
            params.nonce,
            params.currency,
            params.receiver,
            params.data,
            params.amount
          )
        )
      )
    );
  }

  /// @inheritdoc IPayloadBuilder
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    hashes = new bytes32[](1);
    hashes[0] = sha256(payload);
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Eddsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "solana-vm";
  }

  /// @notice Encodes a Solana transfer request in Borsh format
  /// @param domain Domain separator
  /// @param recipient Recipient public key
  /// @param token SPL token public key, or zero for native SOL
  /// @param amount Transfer amount as uint64
  /// @param nonce Unique request nonce
  /// @param expiration Expiration timestamp as int64
  /// @param vaultAddress Solana vault address
  /// @return payload Borsh-encoded transfer request
  function encodeBorsh(
    bytes32 domain,
    bytes32 recipient,
    bytes32 token,
    uint64 amount,
    uint64 nonce,
    int64 expiration,
    bytes32 vaultAddress
  ) internal pure returns (bytes memory payload) {
    payload = bytes.concat(payload, domain);
    payload = bytes.concat(payload, recipient);

    if (token == bytes32(0)) {
      payload = bytes.concat(payload, hex"00");
    } else {
      payload = bytes.concat(payload, hex"01", token);
    }

    payload = bytes.concat(payload, Utils.encodeUint64LE(amount));
    payload = bytes.concat(payload, Utils.encodeUint64LE(nonce));
    payload = bytes.concat(payload, Utils.encodeUint64LE(uint64(expiration)));
    payload = bytes.concat(payload, vaultAddress);
  }
}
