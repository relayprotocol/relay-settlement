// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Config} from "../Config.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";

/// @notice Envelope wrapping a Lighter action and its ABI-encoded parameters
struct LighterPayload {
  uint8 actionType; /// @notice Action type (0 = Transfer)
  bytes parameters;
} /// @notice ABI-encoded action parameters

/// @notice Lighter Transfer request parameters
struct LighterTransferRequest {
  uint64 nonce; /// @notice Lighter transfer nonce
  uint64 fromAccountIndex; /// @notice Source (depository) account index
  uint64 fromRouteType; /// @notice Source route type
  uint64 apiKeyIndex; /// @notice API key index authorizing the transfer
  uint64 toAccountIndex; /// @notice Destination account index
  uint64 toRouteType; /// @notice Destination route type
  uint64 assetIndex; /// @notice Asset index being transferred
  uint64 amount; /// @notice Transfer amount in raw units
  uint64 usdcFee; /// @notice USDC fee charged for the transfer
  uint64 lighterChainId; /// @notice Lighter chain id used in the signed L1 message
  bytes32 memo;
} /// @notice 32-byte memo attached to the transfer

/// @notice Decoded Transfer action input supplied through `params.data`
struct LighterTransferInput {
  uint64 nonce; /// @notice Lighter transfer nonce
  uint64 apiKeyIndex; /// @notice API key index authorizing the transfer
  uint64 usdcFee;
} /// @notice USDC fee charged for the transfer

/// @title LighterVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "lighter-vm" chains
/// @dev Supports Transfer (actionType 0): an L2 transfer authorized via an
///      EIP-191 `personal_sign` over the Lighter L1 message.
contract LighterVmPayloadBuilder is IPayloadBuilder {
  /// @notice Thrown when a payload encodes an unsupported action type
  /// @param actionType Encoded action type
  error UnsupportedActionType(uint8 actionType);

  /// @notice Thrown when a provided value does not fit into uint64
  /// @param value Provided value
  error ValueExceedsUint64(uint256 value);

  /// @notice Thrown when an encoded value has an unexpected length
  /// @param length Actual encoded length
  error InvalidLength(uint256 length);

  /// @notice Transfer action type
  uint8 public constant TRANSFER_ACTION_TYPE = 0;

  /// @notice Config contract used to resolve Lighter currency metadata
  Config public immutable CONFIG;

  /// @notice Depository account index on Lighter that funds are withdrawn from
  uint64 public immutable FROM_ACCOUNT_INDEX;

  /// @notice Lighter chain id embedded in the signed transfer L1 message
  uint64 public immutable LIGHTER_CHAIN_ID;

  /// @notice Prefix used when deriving config keys for Lighter source route type lookups
  bytes32 internal constant LIGHTER_VM_FROM_ROUTE_TYPE_PREFIX =
    keccak256("LIGHTER_VM_FROM_ROUTE_TYPE");

  /// @notice Prefix used when deriving config keys for Lighter destination route type lookups
  bytes32 internal constant LIGHTER_VM_TO_ROUTE_TYPE_PREFIX =
    keccak256("LIGHTER_VM_TO_ROUTE_TYPE");

  /// @notice Prefix used when deriving config keys for Lighter asset index lookups
  bytes32 internal constant LIGHTER_VM_ASSET_INDEX_PREFIX =
    keccak256("LIGHTER_VM_ASSET_INDEX");

  /// @notice Creates a new Lighter VM payload builder
  /// @param _config Config contract address
  /// @param _fromAccountIndex Depository account index on Lighter
  /// @param _lighterChainId Lighter chain id used in signed transfer messages
  constructor(
    address _config,
    uint64 _fromAccountIndex,
    uint64 _lighterChainId
  ) {
    CONFIG = Config(_config);
    FROM_ACCOUNT_INDEX = _fromAccountIndex;
    LIGHTER_CHAIN_ID = _lighterChainId;
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Builds a Transfer payload. `params.data` must encode `(uint64 nonce, uint64 apiKeyIndex, uint64 usdcFee)`.
  function buildPayload(
    string calldata chainId,
    bytes calldata /* depository */,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    return _buildTransferPayload(chainId, params);
  }

  /// @inheritdoc IPayloadBuilder
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    LighterPayload memory decoded = abi.decode(payload, (LighterPayload));

    if (decoded.actionType != TRANSFER_ACTION_TYPE) {
      revert UnsupportedActionType(decoded.actionType);
    }

    LighterTransferRequest memory request = abi.decode(
      decoded.parameters,
      (LighterTransferRequest)
    );

    hashes = new bytes32[](1);
    hashes[0] = MessageHashUtils.toEthSignedMessageHash(
      bytes(buildTransferL1Message(request))
    );
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "lighter-vm";
  }

  /// @notice Returns the config key used to look up source route type for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getFromRouteTypeKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(LIGHTER_VM_FROM_ROUTE_TYPE_PREFIX, chainId, currency)
      );
  }

  /// @notice Returns the config key used to look up destination route type for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getToRouteTypeKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(LIGHTER_VM_TO_ROUTE_TYPE_PREFIX, chainId, currency)
      );
  }

  /// @notice Returns the config key used to look up the Lighter asset index for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getAssetIndexKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(LIGHTER_VM_ASSET_INDEX_PREFIX, chainId, currency)
      );
  }

  /// @notice Returns configured source and destination route types for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return fromRouteType Configured source route type
  /// @return toRouteType Configured destination route type
  function getRouteTypes(
    string calldata chainId,
    bytes calldata currency
  ) public view returns (uint64 fromRouteType, uint64 toRouteType) {
    fromRouteType = _configValueToUint64(
      uint256(CONFIG.getConfigValue(getFromRouteTypeKey(chainId, currency)))
    );
    toRouteType = _configValueToUint64(
      uint256(CONFIG.getConfigValue(getToRouteTypeKey(chainId, currency)))
    );
  }

  /// @notice Returns the configured Lighter asset index for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return assetIndex Configured asset index
  function getAssetIndex(
    string calldata chainId,
    bytes calldata currency
  ) public view returns (uint64 assetIndex) {
    assetIndex = _configValueToUint64(
      uint256(CONFIG.getConfigValue(getAssetIndexKey(chainId, currency)))
    );
  }

  /// @notice Reconstructs the Lighter L1 message text for a Transfer action
  /// @dev Must exactly match the Lighter SDK `transfer()` message format so that
  ///      the recovered signer matches the depository's L1 address.
  /// @param request Transfer request to build the message for
  /// @return message The L1 message text
  function buildTransferL1Message(
    LighterTransferRequest memory request
  ) public pure returns (string memory message) {
    return
      string.concat(
        "Transfer\n\n",
        "nonce: ",
        _toHex16(request.nonce),
        "\n",
        "from: ",
        _toHex16(request.fromAccountIndex),
        " (route ",
        _toHex16(request.fromRouteType),
        ")\n",
        "api key: ",
        _toHex16(request.apiKeyIndex),
        "\n",
        _buildTransferL1MessageTail(request)
      );
  }

  /// @notice Builds the trailing half of the Transfer L1 message
  /// @dev Split from {buildTransferL1Message} to keep `string.concat` arity manageable
  /// @param request Transfer request to build the message for
  /// @return tail The trailing portion of the L1 message text
  function _buildTransferL1MessageTail(
    LighterTransferRequest memory request
  ) internal pure returns (string memory tail) {
    return
      string.concat(
        "to: ",
        _toHex16(request.toAccountIndex),
        " (route ",
        _toHex16(request.toRouteType),
        ")\n",
        "asset: ",
        _toHex16(request.assetIndex),
        "\n",
        "amount: ",
        _toHex16(request.amount),
        "\n",
        "fee: ",
        _toHex16(request.usdcFee),
        "\n",
        "chainId: ",
        _toHex16(request.lighterChainId),
        "\n",
        "memo: ",
        _toHex64(request.memo),
        "\n",
        "Only sign this message for a trusted client!"
      );
  }

  /// @notice Builds the Transfer payload from the request parameters
  /// @param params Payload builder parameters supplied by the allocator
  /// @return payload Encoded Lighter Transfer payload
  function _buildTransferPayload(
    string calldata chainId,
    BuildPayloadParams calldata params
  ) internal view returns (bytes memory payload) {
    LighterTransferInput memory input = abi.decode(
      params.data,
      (LighterTransferInput)
    );
    (uint64 fromRouteType, uint64 toRouteType) = getRouteTypes(
      chainId,
      params.currency
    );

    LighterTransferRequest memory request = LighterTransferRequest({
      nonce: input.nonce,
      fromAccountIndex: FROM_ACCOUNT_INDEX,
      fromRouteType: fromRouteType,
      apiKeyIndex: input.apiKeyIndex,
      toAccountIndex: _bytesToUint64(params.receiver),
      toRouteType: toRouteType,
      assetIndex: getAssetIndex(chainId, params.currency),
      amount: _toUint64(params.amount),
      usdcFee: input.usdcFee,
      lighterChainId: LIGHTER_CHAIN_ID,
      memo: bytes32(0)
    });

    return
      abi.encode(
        LighterPayload({
          actionType: TRANSFER_ACTION_TYPE,
          parameters: abi.encode(request)
        })
      );
  }

  /// @notice Decodes a big-endian byte array into a uint64
  /// @param value Encoded value
  /// @return decoded Decoded uint64 value
  function _bytesToUint64(
    bytes calldata value
  ) internal pure returns (uint64 decoded) {
    if (value.length > 32) {
      revert InvalidLength(value.length);
    }

    uint256 result;
    for (uint256 i; i < value.length; ++i) {
      result = (result << 8) | uint8(value[i]);
    }
    if (result > type(uint64).max) {
      revert ValueExceedsUint64(result);
    }
    return uint64(result);
  }

  /// @notice Casts a uint256 to a uint64, reverting on overflow
  /// @param value Value to cast
  /// @return decoded Casted uint64 value
  function _toUint64(uint256 value) internal pure returns (uint64 decoded) {
    if (value > type(uint64).max) {
      revert ValueExceedsUint64(value);
    }
    return uint64(value);
  }

  /// @notice Casts a config value to a uint64, reverting on overflow
  /// @param value Config value
  /// @return decoded Casted uint64 value
  function _configValueToUint64(
    uint256 value
  ) internal pure returns (uint64 decoded) {
    return _toUint64(value);
  }

  /// @notice Formats a uint64 as a fixed-width `0x`-prefixed 16-digit hex string
  /// @param value Value to format
  /// @return out Hex string of the form `0x` followed by 16 lowercase hex digits
  function _toHex16(uint64 value) internal pure returns (string memory out) {
    bytes16 symbols = "0123456789abcdef";
    bytes memory buffer = new bytes(18);
    buffer[0] = "0";
    buffer[1] = "x";
    for (uint256 i; i < 16; ++i) {
      uint256 shift = (15 - i) * 4;
      buffer[2 + i] = symbols[uint8((value >> shift) & 0xf)];
    }
    return string(buffer);
  }

  /// @notice Formats a bytes32 value as a 64-digit lowercase hex string (no prefix)
  /// @param value Value to format
  /// @return out 64-character lowercase hex string
  function _toHex64(bytes32 value) internal pure returns (string memory out) {
    bytes16 symbols = "0123456789abcdef";
    bytes memory buffer = new bytes(64);
    for (uint256 i; i < 32; ++i) {
      buffer[i * 2] = symbols[uint8(uint8(value[i]) >> 4)];
      buffer[i * 2 + 1] = symbols[uint8(uint8(value[i]) & 0x0f)];
    }
    return string(buffer);
  }
}
