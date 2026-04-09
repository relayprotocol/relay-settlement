// SPDX-License-Identifier: MIT
// ABOUTME: PayloadBuilder for Lighter VM (L2) withdrawal operations.
// ABOUTME: Supports Transfer (personal_sign) and ChangePubKey (EVM tx) action types.
pragma solidity ^0.8.28;

import {IPayloadBuilder} from "../RelayAllocator.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {LibRLP} from "solady/src/utils/LibRLP.sol";
import {LibString} from "solady/src/utils/LibString.sol";

/// @title IRelayAllocator
/// @author Relay Protocol
/// @notice Minimal interface for RelayAllocator owner lookup
interface IRelayAllocator {
  /// @notice Returns the owner address of the RelayAllocator contract
  /// @return The address of the contract owner
  function owner() external view returns (address);
}

/// @notice Action type enum for Lighter operations
enum LighterActionType {
  Transfer, // 0: personal_sign over L1 message text
  ChangePubKey // 1: raw EVM tx to Lighter gateway
}

/// @notice Unified payload — actionType selects the hash format
struct LighterPayload {
  LighterActionType actionType;
  bytes parameters;
}

/// @notice Transfer request parameters
struct LighterTransferRequest {
  uint64 nonce;
  uint64 fromAccountIndex;
  uint64 fromRouteType;
  uint64 apiKeyIndex;
  uint64 toAccountIndex;
  uint64 toRouteType;
  uint64 assetIndex;
  uint64 amount;
  uint64 usdcFee;
  uint64 lighterChainId;
  bytes32 memo;
}

/// @notice ChangePubKey unsigned EVM tx parameters
struct ChangePubKeyTx {
  uint256 txNonce;
  uint256 gasPrice;
  uint256 gasLimit;
  bytes data; // changePubKey(uint48,uint8,bytes) calldata
}

/// @title LighterPayloadBuilder
/// @author Relay Protocol
/// @notice Implements payload building for Lighter L2 operations
/// @dev Transfer: personal_sign L1 message → MPC signs → solver co-signs with WASM → POST to Lighter API
///      ChangePubKey: raw EVM tx → MPC signs tx hash → broadcast on Ethereum mainnet → binds API key
contract LighterPayloadBuilder is IPayloadBuilder {
  using LibRLP for LibRLP.List;

  error NotRelayAllocatorOwner(address account);
  error ZeroAddress();
  error InvalidData();
  error AmountOverflow();
  error InvalidApiKeyIndex();
  error InvalidRouteType();
  error InvalidActionType(uint8 actionType);
  error UnauthorizedApiKey();
  error AccountIndexOverflow();
  error Uint64Overflow();

  /// @notice The RelayAllocator contract that owns this builder
  IRelayAllocator public immutable ALLOCATOR;

  /// @notice Lighter account index for the depository (source of transfers)
  uint64 public immutable FROM_ACCOUNT_INDEX;

  /// @notice Lighter gateway contract on Ethereum mainnet (deposit, withdraw, changePubKey)
  address public immutable LIGHTER_GATEWAY;

  /// @notice Gateway chain ID (Ethereum mainnet = 1) for ChangePubKey EIP-155 signing
  uint256 public immutable GATEWAY_CHAIN_ID;

  /// @notice Whitelisted route types for transfers
  mapping(uint64 => bool) public routeTypeWhitelist;

  /// @notice API key whitelist — key: keccak256(abi.encode(pubkey, apiKeyIndex))
  mapping(bytes32 => bool) public apiKeyWhitelist;

  /// @notice Restricts access to the allocator owner
  modifier onlyAllocatorOwner() {
    if (msg.sender != ALLOCATOR.owner())
      revert NotRelayAllocatorOwner(msg.sender);
    _;
  }

  /// @notice Initializes the payload builder
  /// @param _allocator The RelayAllocator contract
  /// @param _fromAccountIndex Lighter account index (must fit uint48)
  /// @param _lighterGateway Lighter gateway contract on Ethereum mainnet
  /// @param _gatewayChainId Chain ID for ChangePubKey EIP-155 signing (e.g. 1 for mainnet)
  constructor(
    IRelayAllocator _allocator,
    uint64 _fromAccountIndex,
    address _lighterGateway,
    uint256 _gatewayChainId
  ) {
    if (address(_allocator) == address(0) || _lighterGateway == address(0))
      revert ZeroAddress();
    if (_fromAccountIndex > type(uint48).max) revert AccountIndexOverflow();
    ALLOCATOR = _allocator;
    FROM_ACCOUNT_INDEX = _fromAccountIndex;
    LIGHTER_GATEWAY = _lighterGateway;
    GATEWAY_CHAIN_ID = _gatewayChainId;
  }

  /// @notice Whitelists or removes a route type for transfers
  /// @param routeType The route type to set
  /// @param valid Whether the route type is valid
  function setRouteTypeWhitelisted(
    uint64 routeType,
    bool valid
  ) external onlyAllocatorOwner {
    routeTypeWhitelist[routeType] = valid;
  }

  /// @notice Whitelists or removes an API key for ChangePubKey
  /// @param pubkey The API key public key (40 bytes)
  /// @param apiKeyIndex The API key index (4-255, 0-3 reserved)
  /// @param valid Whether the key is whitelisted
  function setApiKeyWhitelisted(
    bytes calldata pubkey,
    uint8 apiKeyIndex,
    bool valid
  ) external onlyAllocatorOwner {
    if (apiKeyIndex < 4) revert InvalidApiKeyIndex();
    apiKeyWhitelist[keccak256(abi.encode(pubkey, apiKeyIndex))] = valid;
  }

  /// @notice Builds a payload for Lighter operations
  /// @dev Transfer:     data = abi.encode(uint8(0), uint64 nonce, uint64 fromRouteType, uint64 toRouteType, uint64 apiKeyIndex, uint64 usdcFee, bytes32 memo)
  ///      ChangePubKey: data = abi.encode(uint8(1), bytes pubkey, uint64 apiKeyIndex, uint256 txNonce, uint256 gasPrice, uint256 gasLimit)
  /// @param chainId Chain ID — used as lighterChainId in Transfer payloads
  /// @param currency Asset index as decimal string
  /// @param amount Transfer amount (must fit uint64)
  /// @param receiver Destination account index as decimal string
  /// @param data ABI-encoded action parameters (first byte = actionType)
  /// @return Encoded LighterPayload
  function buildPayload(
    uint256 chainId,
    string calldata /* depository */,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    if (data.length == 0) revert InvalidData();

    uint8 actionType = abi.decode(data, (uint8));

    if (actionType == uint8(LighterActionType.Transfer)) {
      return _buildTransferPayload(chainId, currency, amount, receiver, data);
    } else if (actionType == uint8(LighterActionType.ChangePubKey)) {
      return _buildChangePubKeyPayload(data);
    } else {
      revert InvalidActionType(actionType);
    }
  }

  /// @notice Returns the hash to sign for the payload
  /// @dev Transfer → EIP-191 personal_sign hash
  ///      ChangePubKey → keccak256(RLP(unsigned EVM tx)) using immutable GATEWAY_CHAIN_ID
  /// @param payload Encoded LighterPayload from buildPayload
  /// @return Hash to sign
  function hashToSign(
    uint256 /* chainId */,
    string calldata /* depository */,
    bytes calldata payload,
    uint32 /* hashIndex */
  ) external view returns (bytes32) {
    LighterPayload memory p = abi.decode(payload, (LighterPayload));

    if (p.actionType == LighterActionType.Transfer) {
      LighterTransferRequest memory req = abi.decode(
        p.parameters,
        (LighterTransferRequest)
      );
      return
        MessageHashUtils.toEthSignedMessageHash(buildTransferL1Message(req));
    } else if (p.actionType == LighterActionType.ChangePubKey) {
      ChangePubKeyTx memory txData = abi.decode(p.parameters, (ChangePubKeyTx));
      return _hashUnsignedTx(txData, GATEWAY_CHAIN_ID);
    } else {
      revert InvalidActionType(uint8(p.actionType));
    }
  }

  /// @notice Returns the signature curve type
  /// @return Curve name string
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  /// @notice Returns the VM family identifier
  /// @return VM family name string
  function family() external pure returns (string memory) {
    return "lighter-vm";
  }

  // ====== Internal: Transfer ======

  /// @notice Builds an encoded Transfer payload from input parameters
  /// @param chainId Lighter chain ID for the L1 message
  /// @param currency Asset index as decimal string
  /// @param amount Transfer amount
  /// @param receiver Destination account index as decimal string
  /// @param data ABI-encoded transfer data
  /// @return Encoded LighterPayload
  function _buildTransferPayload(
    uint256 chainId,
    string calldata currency,
    uint256 amount,
    string calldata receiver,
    bytes calldata data
  ) internal view returns (bytes memory) {
    if (amount > type(uint64).max) revert AmountOverflow();

    LighterTransferRequest memory req = _decodeTransferData(data);
    req.toAccountIndex = _parseUint64(receiver);
    // Lighter gateway: accountIndex is uint48
    if (req.toAccountIndex > type(uint48).max) revert AccountIndexOverflow();
    req.assetIndex = _parseUint64(currency);
    req.amount = uint64(amount);
    req.fromAccountIndex = FROM_ACCOUNT_INDEX;
    if (chainId > type(uint64).max) revert Uint64Overflow();
    req.lighterChainId = uint64(chainId);

    return
      abi.encode(LighterPayload(LighterActionType.Transfer, abi.encode(req)));
  }

  /// @notice Decodes and validates transfer data from the raw input
  /// @param data ABI-encoded transfer parameters
  /// @return request Partially populated LighterTransferRequest
  function _decodeTransferData(
    bytes calldata data
  ) internal view returns (LighterTransferRequest memory request) {
    (
      ,
      uint64 nonce,
      uint64 fromRouteType,
      uint64 toRouteType,
      uint64 apiKeyIndex,
      uint64 usdcFee,
      bytes32 memo
    ) = abi.decode(
        data,
        (uint8, uint64, uint64, uint64, uint64, uint64, bytes32)
      );

    // Lighter gateway types: apiKeyIndex is uint8 (0-255, 0-3 reserved)
    if (apiKeyIndex > type(uint8).max || apiKeyIndex < 4)
      revert InvalidApiKeyIndex();
    if (!routeTypeWhitelist[fromRouteType] || !routeTypeWhitelist[toRouteType])
      revert InvalidRouteType();

    request.nonce = nonce;
    request.fromRouteType = fromRouteType;
    request.toRouteType = toRouteType;
    request.apiKeyIndex = apiKeyIndex;
    request.usdcFee = usdcFee;
    request.memo = memo;
  }

  // ====== Internal: ChangePubKey ======

  /// @notice Builds an encoded ChangePubKey payload
  /// @param data ABI-encoded ChangePubKey parameters
  /// @return Encoded LighterPayload containing a ChangePubKeyTx
  function _buildChangePubKeyPayload(
    bytes calldata data
  ) internal view returns (bytes memory) {
    (
      ,
      bytes memory newPubkey,
      uint64 apiKeyIndex,
      uint256 txNonce,
      uint256 gasPrice,
      uint256 gasLimit
    ) = abi.decode(data, (uint8, bytes, uint64, uint256, uint256, uint256));

    if (apiKeyIndex > type(uint8).max || apiKeyIndex < 4)
      revert InvalidApiKeyIndex();
    if (!apiKeyWhitelist[keccak256(abi.encode(newPubkey, apiKeyIndex))])
      revert UnauthorizedApiKey();

    bytes memory callData = abi.encodeWithSignature(
      "changePubKey(uint48,uint8,bytes)",
      uint48(FROM_ACCOUNT_INDEX),
      uint8(apiKeyIndex),
      newPubkey
    );

    ChangePubKeyTx memory txData = ChangePubKeyTx({
      txNonce: txNonce,
      gasPrice: gasPrice,
      gasLimit: gasLimit,
      data: callData
    });

    return
      abi.encode(
        LighterPayload(LighterActionType.ChangePubKey, abi.encode(txData))
      );
  }

  /// @notice Computes keccak256(RLP(unsigned EIP-155 tx)) using Solady LibRLP
  /// @param txData The unsigned transaction parameters
  /// @param chainId The chain ID for EIP-155 replay protection
  /// @return The transaction hash to sign
  function _hashUnsignedTx(
    ChangePubKeyTx memory txData,
    uint256 chainId
  ) internal view returns (bytes32) {
    // RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
    LibRLP.List memory list = LibRLP
      .p(txData.txNonce)
      .p(txData.gasPrice)
      .p(txData.gasLimit)
      .p(LIGHTER_GATEWAY)
      .p(uint256(0));
    list = list.p(txData.data).p(chainId).p(uint256(0)).p(uint256(0));
    return keccak256(list.encode());
  }

  // ====== Public: Transfer L1 message ======

  /// @notice Reconstructs Transfer L1 message matching lighter-ts SDK format
  /// @dev Uses Solady LibString for hex conversion
  /// @param req The transfer request parameters
  /// @return The L1 message bytes for personal_sign
  function buildTransferL1Message(
    LighterTransferRequest memory req
  ) public pure returns (bytes memory) {
    bytes memory part1 = abi.encodePacked(
      "Transfer\n\nnonce: ",
      _toHex16(req.nonce),
      "\nfrom: ",
      _toHex16(req.fromAccountIndex),
      " (route ",
      _toHex16(req.fromRouteType),
      ")",
      "\napi key: ",
      _toHex16(req.apiKeyIndex)
    );
    bytes memory part2 = abi.encodePacked(
      "\nto: ",
      _toHex16(req.toAccountIndex),
      " (route ",
      _toHex16(req.toRouteType),
      ")",
      "\nasset: ",
      _toHex16(req.assetIndex),
      "\namount: ",
      _toHex16(req.amount),
      "\nfee: ",
      _toHex16(req.usdcFee)
    );
    bytes memory part3 = abi.encodePacked(
      "\nchainId: ",
      _toHex16(req.lighterChainId),
      "\nmemo: ",
      LibString.toHexStringNoPrefix(uint256(req.memo), 32),
      "\nOnly sign this message for a trusted client!"
    );
    return abi.encodePacked(part1, part2, part3);
  }

  // ====== Internal helpers ======

  /// @notice Converts uint64 to "0x" + 16-char zero-padded lowercase hex
  /// @param value The uint64 value to convert
  /// @return The hex string representation
  function _toHex16(uint64 value) internal pure returns (string memory) {
    return LibString.toHexString(uint256(value), 8);
  }

  /// @notice Parses decimal string to uint64 using OpenZeppelin Strings.parseUint
  /// @param s The decimal string to parse
  /// @return The parsed uint64 value
  function _parseUint64(string memory s) internal pure returns (uint64) {
    uint256 result = Strings.parseUint(s);
    if (result > type(uint64).max) revert Uint64Overflow();
    return uint64(result);
  }
}
