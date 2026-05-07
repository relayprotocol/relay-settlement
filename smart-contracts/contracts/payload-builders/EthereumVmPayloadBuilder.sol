// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Config} from "../Config.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @notice Individual call within a batch request
struct Call {
  address to; /// @notice Target contract address
  bytes data; /// @notice Call data
  uint256 value; /// @notice Native token value to send
  bool allowFailure;
} /// @notice Whether the batch may continue if this call fails

/// @notice Batch call request for a depository
struct CallRequest {
  Call[] calls; /// @notice Array of calls to execute
  uint256 nonce; /// @notice Request nonce for replay protection
  uint256 expiration;
} /// @notice Request expiration timestamp

/// @title EthereumVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "ethereum-vm" chains
contract EthereumVmPayloadBuilder is IPayloadBuilder {
  /// @notice Thrown when an encoded receiver address does not have the expected length
  /// @param length Actual encoded length
  error InvalidReceiverLength(uint256 length);

  /// @notice Thrown when an encoded currency address does not have the expected length
  /// @param length Actual encoded length
  error InvalidCurrencyLength(uint256 length);

  /// @notice Thrown when an encoded depository address does not have the expected length
  /// @param length Actual encoded length
  error InvalidDepositoryLength(uint256 length);

  /// @notice Config contract used to resolve namespaced chain metadata
  Config public immutable CONFIG;

  /// @notice Prefix used when deriving config keys for Ethereum VM chain id lookups
  bytes32 internal constant ETHEREUM_VM_CHAIN_ID_PREFIX =
    keccak256("ETHEREUM_VM_CHAIN_ID");

  /// @notice Prefix used when deriving config keys for Ethereum VM request expiration lookups
  bytes32 internal constant ETHEREUM_VM_EXPIRATION_PREFIX =
    keccak256("ETHEREUM_VM_EXPIRATION");

  /// @notice The signing domain for EIP712
  string public constant SIGNING_DOMAIN = "RelayDepository";
  /// @notice The signature version for EIP712
  string public constant SIGNATURE_VERSION = "1";

  /// @notice EIP-712 typehash for Call struct
  bytes32 public constant CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");

  /// @notice EIP-712 typehash for CallRequest struct
  bytes32 public constant CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

  /// @notice Creates a new Ethereum VM payload builder
  /// @param _config Config contract address
  constructor(address _config) {
    CONFIG = Config(_config);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Builds a single-call payload that transfers either native ETH or ERC-20 tokens.
  function buildPayload(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    if (params.receiver.length != 20) {
      revert InvalidReceiverLength(params.receiver.length);
    }
    if (params.currency.length != 20) {
      revert InvalidCurrencyLength(params.currency.length);
    }

    uint256 expirationDelay = uint256(
      CONFIG.getConfigValue(getExpirationKey())
    );
    CallRequest memory request = CallRequest({
      calls: new Call[](1),
      nonce: computeNonce(params),
      expiration: block.timestamp + expirationDelay
    });

    address currencyAddress = address(bytes20(params.currency));
    address receiverAddress = address(bytes20(params.receiver));
    if (currencyAddress == address(0)) {
      // If this is a native transfer, we need to set the value to the amount and the data to an empty bytes array
      request.calls[0] = Call({
        to: receiverAddress,
        data: bytes(""),
        value: params.amount,
        allowFailure: false
      });
    } else {
      // Otherwise we assume this is an ERC20 transfer
      request.calls[0] = Call({
        to: currencyAddress,
        data: abi.encodeWithSignature(
          "transfer(address,uint256)",
          receiverAddress,
          params.amount
        ),
        value: 0,
        allowFailure: false
      });
    }

    return abi.encode(request);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Resolves the numeric EVM chain id from Config before building the EIP-712 domain separator.
  function hashesToSign(
    string calldata chainId,
    bytes calldata depository,
    bytes calldata payload
  ) external view override returns (bytes32[] memory hashes) {
    if (depository.length != 20) {
      revert InvalidDepositoryLength(depository.length);
    }

    uint256 evmChainId = uint256(
      CONFIG.getConfigValue(getEvmChainIdKey(chainId))
    );
    bytes32 domainSeparator = Utils.buildDomainSeparator(
      SIGNING_DOMAIN,
      SIGNATURE_VERSION,
      evmChainId,
      address(bytes20(depository))
    );

    CallRequest memory request = abi.decode(payload, (CallRequest));
    bytes32 eip712Hash = hashCallRequest(request, domainSeparator);

    hashes = new bytes32[](1);
    hashes[0] = eip712Hash;
  }

  /// @notice Returns the config key used to map a Relay chain id to an EVM chain id
  /// @param chainId Relay chain id
  /// @return key Config key
  function getEvmChainIdKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(ETHEREUM_VM_CHAIN_ID_PREFIX, chainId));
  }

  /// @notice Returns the config key used to look up the default EVM request expiration delay
  /// @return key Config key
  function getExpirationKey() public pure returns (bytes32 key) {
    return ETHEREUM_VM_EXPIRATION_PREFIX;
  }

  /// @notice Computes the request nonce from the block number and request-specific payload fields
  /// @param params Payload builder parameters supplied by the allocator
  /// @return nonce Derived request nonce
  function computeNonce(
    BuildPayloadParams calldata params
  ) internal view returns (uint256 nonce) {
    nonce = uint256(
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
    );
  }

  /// @notice Hashes a CallRequest and returns its EIP-712 digest
  /// @param request CallRequest to hash
  /// @param domainSeparator EIP-712 domain separator
  /// @return eip712Hash EIP-712 hash
  function hashCallRequest(
    CallRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32 eip712Hash) {
    // Initialize the array of call hashes
    bytes32[] memory callHashes = new bytes32[](request.calls.length);

    // Iterate over the underlying calls
    for (uint256 i = 0; i < request.calls.length; ++i) {
      // Hash the call
      bytes32 callHash = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          request.calls[i].to,
          keccak256(request.calls[i].data),
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );

      // Store the hash in the array
      callHashes[i] = callHash;
    }

    // Get the struct hash
    bytes32 structHash = keccak256(
      abi.encode(
        CALL_REQUEST_TYPEHASH,
        keccak256(abi.encodePacked(callHashes)),
        request.nonce,
        request.expiration
      )
    );

    // Get the EIP-712 hash
    eip712Hash = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "ethereum-vm";
  }
}
