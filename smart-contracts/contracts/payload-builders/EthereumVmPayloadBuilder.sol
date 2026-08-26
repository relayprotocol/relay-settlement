// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Config} from "../Config.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @notice Individual call within a batch request
/// @dev A call carries either its calldata or a commitment to it, and both forms hash to the
/// same EIP-712 digest, so the executor can supply the calldata a committed call omits
struct Call {
  address to; /// @notice Target contract address
  bytes data; /// @notice Call data
  bytes32 dataHash; /// @notice Commitment to the call data, zero when `data` is supplied
  uint256 value; /// @notice Native token value to send
  bool allowFailure;
} /// @notice Whether the batch may continue if this call fails

/// @notice Batch call request for a depository
struct CallRequest {
  Call[] calls; /// @notice Array of calls to execute
  uint256 nonce; /// @notice Request nonce for replay protection
  uint256 expiration;
} /// @notice Request expiration timestamp

/// @notice Versioned routed withdrawal data bundling the selected router and its call commitment
/// @param version Routed data version, must equal ROUTED_WITHDRAWAL_DATA_VERSION
/// @param router Allowlisted router receiving the withdrawal and executing the calls
/// @param dataHash Commitment to the calldata of the router call, keeping the calls off-chain
struct RoutedWithdrawalData {
  uint8 version;
  address router;
  bytes32 dataHash;
}

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

  /// @notice Thrown when routed withdrawal data has an unsupported version
  /// @param version Actual encoded version
  error UnsupportedRoutedDataVersion(uint8 version);

  /// @notice Thrown when routed withdrawal data commits to a degenerate calldata hash
  /// @dev Zero reads as uncommitted and `keccak256("")` is a bare call. A commitment to a
  /// bundle that runs but does nothing is not detectable from a hash.
  error EmptyRoutedCallsHash();

  /// @notice Thrown when a call supplies both its calldata and a commitment to it
  error AmbiguousCallData();

  /// @notice Thrown when the router is not allowlisted for the chain and depository
  /// @param router Router address
  error RouterNotAllowed(address router);

  /// @notice Config contract used to resolve namespaced chain metadata
  Config public immutable CONFIG;

  /// @notice Prefix used when deriving config keys for Ethereum VM chain id lookups
  bytes32 internal constant ETHEREUM_VM_CHAIN_ID_PREFIX =
    keccak256("ETHEREUM_VM_CHAIN_ID");

  /// @notice Prefix used when deriving config keys for Ethereum VM request expiration lookups
  bytes32 internal constant ETHEREUM_VM_EXPIRATION_PREFIX =
    keccak256("ETHEREUM_VM_EXPIRATION");

  /// @notice Prefix used when deriving config keys for Ethereum VM router allowlist lookups
  bytes32 internal constant ETHEREUM_VM_ROUTER_ALLOWED_PREFIX =
    keccak256("ETHEREUM_VM_ROUTER_ALLOWED");

  /// @notice Hash of empty calldata, which no routed bundle may commit to
  bytes32 internal constant EMPTY_CALLDATA_HASH = keccak256("");

  /// @notice Supported routed withdrawal data version
  uint8 public constant ROUTED_WITHDRAWAL_DATA_VERSION = 1;

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
  /// @dev Empty `params.data` builds a single native or ERC-20 transfer to the receiver.
  /// Routed data adds a call committing to the router calldata the executor supplies.
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
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

    address currencyAddress = address(bytes20(params.currency));
    address receiverAddress = address(bytes20(params.receiver));

    Call[] memory calls = new Call[](params.data.length == 0 ? 1 : 2);
    calls[0] = _transferCall(currencyAddress, receiverAddress, params.amount);
    if (params.data.length != 0) {
      RoutedWithdrawalData memory routed = _decodeRoutedWithdrawalData(
        chainId,
        depository,
        params.data
      );

      calls[1] = Call({
        to: routed.router,
        data: bytes(""),
        dataHash: routed.dataHash,
        value: 0,
        allowFailure: false
      });
    }

    CallRequest memory request = CallRequest({
      calls: calls,
      nonce: computeNonce(chainId, depository, params),
      expiration: block.timestamp + expirationDelay
    });

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

  /// @notice Returns the config key allowlisting a router for a chain and depository
  /// @param chainId Relay chain id
  /// @param depository Depository address on the withdrawal chain
  /// @param router Router address on the withdrawal chain
  /// @return key Config key
  function getRouterAllowedKey(
    string calldata chainId,
    address depository,
    address router
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encode(
          ETHEREUM_VM_ROUTER_ALLOWED_PREFIX,
          keccak256(bytes(chainId)),
          depository,
          router
        )
      );
  }

  /// @notice Computes the request nonce from the block, the builder identity, and the full request
  /// @dev Commits to `address(this)`, the chain id, the depository, and every field of `params`, so
  /// a nonce built for one builder, chain, or depository can never be reused for another.
  /// `block.number` leads the preimage so a rebuild of the same request in a later block yields a
  /// fresh nonce.
  /// @param chainId Relay chain id of the withdrawal chain
  /// @param depository Encoded depository address on the withdrawal chain
  /// @param params Payload builder parameters supplied by the allocator
  /// @return nonce Derived request nonce
  function computeNonce(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) internal view returns (uint256 nonce) {
    nonce = uint256(
      keccak256(
        abi.encode(block.number, address(this), chainId, depository, params)
      )
    );
  }

  /// @notice Builds the native or ERC-20 withdrawal transfer call
  /// @param currencyAddress Withdrawal currency, zero address for native transfers
  /// @param receiverAddress Address receiving the withdrawal
  /// @param amount Withdrawal amount
  /// @return transferCall Depository call transferring the withdrawal
  function _transferCall(
    address currencyAddress,
    address receiverAddress,
    uint256 amount
  ) internal pure returns (Call memory transferCall) {
    if (currencyAddress == address(0)) {
      // If this is a native transfer, we need to set the value to the amount and the data to an empty bytes array
      transferCall = Call({
        to: receiverAddress,
        data: bytes(""),
        dataHash: bytes32(0),
        value: amount,
        allowFailure: false
      });
    } else {
      // Otherwise we assume this is an ERC20 transfer
      transferCall = Call({
        to: currencyAddress,
        data: abi.encodeWithSignature(
          "transfer(address,uint256)",
          receiverAddress,
          amount
        ),
        dataHash: bytes32(0),
        value: 0,
        allowFailure: false
      });
    }
  }

  /// @notice Decodes routed withdrawal data and enforces the routed-mode constraints
  /// @param chainId Relay chain id
  /// @param depository Encoded depository address
  /// @param data Encoded routed withdrawal data
  /// @return routed Decoded routed withdrawal data
  function _decodeRoutedWithdrawalData(
    string calldata chainId,
    bytes calldata depository,
    bytes calldata data
  ) internal view returns (RoutedWithdrawalData memory routed) {
    if (depository.length != 20) {
      revert InvalidDepositoryLength(depository.length);
    }

    routed = abi.decode(data, (RoutedWithdrawalData));
    if (routed.version != ROUTED_WITHDRAWAL_DATA_VERSION) {
      revert UnsupportedRoutedDataVersion(routed.version);
    }
    if (
      routed.dataHash == bytes32(0) || routed.dataHash == EMPTY_CALLDATA_HASH
    ) {
      revert EmptyRoutedCallsHash();
    }

    // `Config` reverts on an unset key and cannot delete one, so revoking an
    // allowlisted router means overwriting its value: `1` allows, anything else does not
    bytes32 allowedValue = CONFIG.getConfigValue(
      getRouterAllowedKey(chainId, address(bytes20(depository)), routed.router)
    );
    if (allowedValue != bytes32(uint256(1))) {
      revert RouterNotAllowed(routed.router);
    }
  }

  /// @notice Hashes a CallRequest and returns its EIP-712 digest
  /// @dev A committed call substitutes its `dataHash` for `keccak256(data)`, so the digest
  /// equals the one the depository derives from the same call with its calldata supplied
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
      bytes32 dataHash = request.calls[i].dataHash;
      if (dataHash == bytes32(0)) {
        dataHash = keccak256(request.calls[i].data);
      } else if (request.calls[i].data.length != 0) {
        revert AmbiguousCallData();
      }

      // Hash the call
      bytes32 callHash = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          request.calls[i].to,
          dataHash,
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
