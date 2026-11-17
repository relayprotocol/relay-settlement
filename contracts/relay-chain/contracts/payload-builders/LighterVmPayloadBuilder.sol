// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Config} from "../Config.sol";
import {
  IPayloadBuilder,
  WithdrawRequest,
  WithdrawFee
} from "../RelayAllocator.sol";

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
///      A payload is `abi.encode(uint8 actionType, <action request>)`: the action
///      type is always the first word and selects the request struct that follows.
///      A Transfer payload is `abi.encode(uint8(0), LighterTransferRequest)`, a fully
///      static 12-word encoding.
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

  /// @notice Thrown when the depository the request is routed under is not the
  ///         account index configured for the chain
  /// @param depository Account index decoded from the depository argument
  /// @param fromAccountIndex Account index configured for the chain
  error DepositoryMismatch(uint64 depository, uint64 fromAccountIndex);

  /// @notice Thrown when the caller-supplied USDC fee exceeds the maximum in effect
  /// @param fee Provided USDC fee
  /// @param maxFee Maximum USDC fee in effect
  error FeeExceedsMaxFee(uint64 fee, uint64 maxFee);

  /// @notice Thrown when the request currency is not the 16-byte lighter-vm encoding
  /// @param length Provided currency length
  error InvalidCurrencyLength(uint256 length);

  /// @notice Thrown when a currency's configured asset index is zero (disabled)
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  error CurrencyDisabled(string chainId, bytes currency);

  /// @notice Transfer action type
  uint8 public constant TRANSFER_ACTION_TYPE = 0;

  /// @notice Upper bound (in USDC base units) on the caller-supplied transfer fee
  ///         when no `LIGHTER_VM_MAX_USDC_FEE` config override is set, 3 USDC.
  /// @dev A sanity ceiling rather than the primary control: the Lighter sequencer
  ///      rejects any `usdcFee` that differs from its live quote. The fee is still
  ///      charged to the shared depository account on top of `amount`, so this bounds
  ///      what one request can ask that account to pay should that check ever change,
  ///      at three times Lighter's standard 1 USDC transfer fee.
  uint64 public constant DEFAULT_MAX_USDC_FEE = 3_000_000;

  /// @notice Config contract used to resolve Lighter instance and currency metadata
  Config public immutable CONFIG;

  /// @notice Prefix used when deriving config keys for Lighter depository account index lookups
  bytes32 internal constant LIGHTER_VM_FROM_ACCOUNT_INDEX_PREFIX =
    keccak256("LIGHTER_VM_FROM_ACCOUNT_INDEX");

  /// @notice Prefix used when deriving config keys for Lighter app-chain id lookups
  bytes32 internal constant LIGHTER_VM_CHAIN_ID_PREFIX =
    keccak256("LIGHTER_VM_CHAIN_ID");

  /// @notice Prefix used when deriving config keys for Lighter source route type lookups
  bytes32 internal constant LIGHTER_VM_FROM_ROUTE_TYPE_PREFIX =
    keccak256("LIGHTER_VM_FROM_ROUTE_TYPE");

  /// @notice Prefix used when deriving config keys for Lighter destination route type lookups
  bytes32 internal constant LIGHTER_VM_TO_ROUTE_TYPE_PREFIX =
    keccak256("LIGHTER_VM_TO_ROUTE_TYPE");

  /// @notice Prefix used when deriving config keys for Lighter asset index lookups
  bytes32 internal constant LIGHTER_VM_ASSET_INDEX_PREFIX =
    keccak256("LIGHTER_VM_ASSET_INDEX");

  /// @notice Prefix used when deriving config keys for Lighter maximum USDC fee lookups
  bytes32 internal constant LIGHTER_VM_MAX_USDC_FEE_PREFIX =
    keccak256("LIGHTER_VM_MAX_USDC_FEE");

  /// @notice Creates a new Lighter VM payload builder
  /// @dev Instance-specific values (depository account index, Lighter app-chain
  ///      id) are read from `CONFIG` per Relay chain id, so one builder can serve
  ///      every Lighter instance.
  /// @param _config Config contract address
  constructor(address _config) {
    CONFIG = Config(_config);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Builds a Transfer payload. `params.data` must encode `(uint64 nonce, uint64 apiKeyIndex, uint64 usdcFee)`
  ///      and `usdcFee` may not exceed {getMaxUsdcFee}. `params.currency` must be the
  ///      16-byte lighter-vm encoding. `depository` must decode to
  ///      the account index configured for `chainId`, so the signed source account
  ///      is always the one the allocator routed the request under.
  ///      Like Bitcoin's identifier, the signed memo binds the builder, chain,
  ///      depository, and all builder inputs, including the Relay request nonce.
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    WithdrawRequest calldata params
  )
    external
    view
    override
    returns (bytes memory payload, WithdrawFee memory withdrawFee)
  {
    return (_buildTransferPayload(chainId, depository, params), withdrawFee);
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Reads the action type alone first, so an unsupported type reverts
  ///      before its request is decoded
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    uint8 actionType = abi.decode(payload, (uint8));
    if (actionType != TRANSFER_ACTION_TYPE) {
      revert UnsupportedActionType(actionType);
    }

    (, LighterTransferRequest memory request) = abi.decode(
      payload,
      (uint8, LighterTransferRequest)
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

  /// @notice Returns the config key used to look up the depository account index for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getFromAccountIndexKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(LIGHTER_VM_FROM_ACCOUNT_INDEX_PREFIX, chainId)
      );
  }

  /// @notice Returns the config key used to look up the Lighter app-chain id for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getLighterChainIdKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(LIGHTER_VM_CHAIN_ID_PREFIX, chainId));
  }

  /// @notice Returns the configured depository account index funds are withdrawn from
  /// @dev Reverts when the key is unset
  /// @param chainId Relay chain id
  /// @return fromAccountIndex Configured depository account index on Lighter
  function getFromAccountIndex(
    string calldata chainId
  ) public view returns (uint64 fromAccountIndex) {
    fromAccountIndex = _configValueToUint64(
      uint256(CONFIG.getConfigValue(getFromAccountIndexKey(chainId)))
    );
  }

  /// @notice Returns the configured Lighter app-chain id embedded in the signed L1 message
  /// @dev Reverts when the key is unset
  /// @param chainId Relay chain id
  /// @return lighterChainId Configured Lighter app-chain id
  function getLighterChainId(
    string calldata chainId
  ) public view returns (uint64 lighterChainId) {
    lighterChainId = _configValueToUint64(
      uint256(CONFIG.getConfigValue(getLighterChainIdKey(chainId)))
    );
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
        abi.encodePacked(
          LIGHTER_VM_FROM_ROUTE_TYPE_PREFIX,
          keccak256(bytes(chainId)),
          currency
        )
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
        abi.encodePacked(
          LIGHTER_VM_TO_ROUTE_TYPE_PREFIX,
          keccak256(bytes(chainId)),
          currency
        )
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
        abi.encodePacked(
          LIGHTER_VM_ASSET_INDEX_PREFIX,
          keccak256(bytes(chainId)),
          currency
        )
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
  /// @dev Reverts when the key is unset or zero; Lighter has no asset 0, so
  ///      writing zero is how a currency is disabled
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
    if (assetIndex == 0) {
      revert CurrencyDisabled(chainId, currency);
    }
  }

  /// @notice Returns the config key used to look up the maximum USDC fee for a chain
  /// @param chainId Relay chain id
  /// @return key Config key
  function getMaxUsdcFeeKey(
    string calldata chainId
  ) public pure returns (bytes32 key) {
    return keccak256(abi.encodePacked(LIGHTER_VM_MAX_USDC_FEE_PREFIX, chainId));
  }

  /// @notice Returns the maximum USDC fee in effect for a chain
  /// @dev An unset key, or any config lookup revert, falls back to
  ///      {DEFAULT_MAX_USDC_FEE}; a set key is used verbatim, so zero admits
  ///      fee-free transfers only.
  /// @param chainId Relay chain id
  /// @return maxUsdcFee Maximum USDC fee in USDC base units
  function getMaxUsdcFee(
    string calldata chainId
  ) public view returns (uint64 maxUsdcFee) {
    try CONFIG.getConfigValue(getMaxUsdcFeeKey(chainId)) returns (
      bytes32 value
    ) {
      return _configValueToUint64(uint256(value));
    } catch {
      return DEFAULT_MAX_USDC_FEE;
    }
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
  /// @param chainId Relay chain id of the withdrawal chain
  /// @param depository Encoded depository account index the request is routed under
  /// @param params Withdrawal request supplied by the allocator
  /// @return payload Encoded Lighter Transfer payload
  function _buildTransferPayload(
    string calldata chainId,
    bytes calldata depository,
    WithdrawRequest calldata params
  ) internal view returns (bytes memory payload) {
    if (params.currency.length != 16) {
      revert InvalidCurrencyLength(params.currency.length);
    }
    LighterTransferInput memory input = abi.decode(
      params.data,
      (LighterTransferInput)
    );
    uint64 maxUsdcFee = getMaxUsdcFee(chainId);
    if (input.usdcFee > maxUsdcFee) {
      revert FeeExceedsMaxFee(input.usdcFee, maxUsdcFee);
    }
    uint64 fromAccountIndex = getFromAccountIndex(chainId);
    uint64 depositoryAccountIndex = _bytesToUint64(depository);
    if (depositoryAccountIndex != fromAccountIndex) {
      revert DepositoryMismatch(depositoryAccountIndex, fromAccountIndex);
    }
    (uint64 fromRouteType, uint64 toRouteType) = getRouteTypes(
      chainId,
      params.currency
    );

    LighterTransferRequest memory request = LighterTransferRequest({
      nonce: input.nonce,
      fromAccountIndex: fromAccountIndex,
      fromRouteType: fromRouteType,
      apiKeyIndex: input.apiKeyIndex,
      toAccountIndex: _bytesToUint64(params.receiver),
      toRouteType: toRouteType,
      assetIndex: getAssetIndex(chainId, params.currency),
      amount: _toUint64(params.amount),
      usdcFee: input.usdcFee,
      lighterChainId: getLighterChainId(chainId),
      memo: keccak256(abi.encode(address(this), params))
    });

    return abi.encode(TRANSFER_ACTION_TYPE, request);
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
