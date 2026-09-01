// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Config} from "../Config.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Utils} from "../Utils.sol";

/// @notice Envelope used for Hyperliquid payloads
struct HyperliquidPayload {
  uint8 txType;
  bytes parameters;
}

/// @notice Hyperliquid usdSend request parameters
struct UsdSendRequest {
  string hyperliquidChain;
  string destination;
  string amount;
  uint64 time;
}

/// @notice Hyperliquid sendAsset request parameters
struct SendAssetRequest {
  string hyperliquidChain;
  string destination;
  string sourceDex;
  string destinationDex;
  string token;
  string amount;
  string fromSubAccount;
  uint64 nonce;
}

/// @title HyperliquidVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for Hyperliquid usdSend and sendAsset actions
contract HyperliquidVmPayloadBuilder is IPayloadBuilder {
  /// @notice Thrown when an encoded receiver address does not have the expected length
  /// @param length Actual encoded length
  error InvalidReceiverLength(uint256 length);

  /// @notice Thrown when an encoded currency does not have the expected length
  /// @param length Actual encoded length
  error InvalidCurrencyLength(uint256 length);

  /// @notice Thrown when configured target decimals exceed the supported range
  /// @param decimals Configured decimals
  error TargetDecimalsTooLarge(uint256 decimals);

  /// @notice Thrown when hashesToSign receives a payload with an unsupported transaction type
  /// @param txType Encoded transaction type
  error UnsupportedTransactionType(uint8 txType);

  /// @notice Retained for ABI compatibility with earlier nonce-time validation
  error InvalidNonceTime();

  /// @notice Config contract used to resolve Hyperliquid currency metadata
  Config public immutable CONFIG;

  /// @notice Hyperliquid EIP-712 domain chain id
  uint256 public immutable SIGNATURE_CHAIN_ID;

  /// @notice Hyperliquid environment name used in signed requests
  string public hyperliquidChain;

  /// @notice Hyperliquid usdSend envelope type
  uint8 public constant USD_SEND_TX_TYPE = 0;

  /// @notice Hyperliquid sendAsset envelope type
  uint8 public constant SEND_ASSET_TX_TYPE = 1;

  /// @notice Maximum target decimals accepted for amount formatting
  uint8 public constant MAX_TARGET_DECIMALS = 18;

  /// @notice Prefix used when deriving config keys for Hyperliquid target decimal lookups
  bytes32 internal constant HYPERLIQUID_VM_TARGET_DECIMALS_PREFIX =
    keccak256("HYPERLIQUID_VM_TARGET_DECIMALS");

  /// @notice Prefix used when deriving config keys for Hyperliquid currency symbol lookups
  bytes32 internal constant HYPERLIQUID_VM_CURRENCY_SYMBOL_PREFIX =
    keccak256("HYPERLIQUID_VM_CURRENCY_SYMBOL");

  /// @notice Prefix used when deriving config keys for Hyperliquid source DEX lookups
  bytes32 internal constant HYPERLIQUID_VM_SOURCE_DEX_PREFIX =
    keccak256("HYPERLIQUID_VM_SOURCE_DEX");

  /// @notice Prefix used when deriving config keys for Hyperliquid destination DEX lookups
  bytes32 internal constant HYPERLIQUID_VM_DESTINATION_DEX_PREFIX =
    keccak256("HYPERLIQUID_VM_DESTINATION_DEX");

  /// @notice The signing domain for Hyperliquid transactions
  string public constant SIGNING_DOMAIN = "HyperliquidSignTransaction";

  /// @notice The signature version for Hyperliquid transactions
  string public constant SIGNATURE_VERSION = "1";

  /// @notice EIP-712 typehash for Hyperliquid usdSend requests
  bytes32 public constant USD_SEND_TYPEHASH =
    keccak256(
      "HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)"
    );

  /// @notice EIP-712 typehash for Hyperliquid sendAsset requests
  bytes32 public constant SEND_ASSET_TYPEHASH =
    keccak256(
      "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)"
    );

  /// @notice Creates a new Hyperliquid VM payload builder
  /// @param _config Config contract address
  /// @param _signatureChainId Hyperliquid EIP-712 domain chain id
  /// @param _hyperliquidChain Hyperliquid environment name used in signed requests
  constructor(
    address _config,
    uint256 _signatureChainId,
    string memory _hyperliquidChain
  ) {
    CONFIG = Config(_config);
    SIGNATURE_CHAIN_ID = _signatureChainId;
    hyperliquidChain = _hyperliquidChain;
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Builds Hyperliquid usdSend for native currency and sendAsset otherwise.
  function buildPayload(
    string calldata chainId,
    bytes calldata /* depository */,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    if (params.receiver.length != 20) {
      revert InvalidReceiverLength(params.receiver.length);
    }
    if (params.currency.length != 16) {
      revert InvalidCurrencyLength(params.currency.length);
    }

    if (_isNativeCurrency(params.currency)) {
      return
        abi.encode(
          HyperliquidPayload({
            txType: USD_SEND_TX_TYPE,
            parameters: abi.encode(_buildUsdSendRequest(chainId, params))
          })
        );
    }

    return
      abi.encode(
        HyperliquidPayload({
          txType: SEND_ASSET_TX_TYPE,
          parameters: abi.encode(_buildSendAssetRequest(chainId, params))
        })
      );
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Hashes Hyperliquid usdSend and sendAsset payloads.
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external view override returns (bytes32[] memory hashes) {
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    bytes32 domainSeparator = Utils.buildDomainSeparator(
      SIGNING_DOMAIN,
      SIGNATURE_VERSION,
      SIGNATURE_CHAIN_ID,
      address(0)
    );

    hashes = new bytes32[](1);
    if (decoded.txType == USD_SEND_TX_TYPE) {
      UsdSendRequest memory request = abi.decode(
        decoded.parameters,
        (UsdSendRequest)
      );
      hashes[0] = MessageHashUtils.toTypedDataHash(
        domainSeparator,
        hashUsdSendRequest(request)
      );
    } else if (decoded.txType == SEND_ASSET_TX_TYPE) {
      SendAssetRequest memory request = abi.decode(
        decoded.parameters,
        (SendAssetRequest)
      );
      hashes[0] = MessageHashUtils.toTypedDataHash(
        domainSeparator,
        hashSendAssetRequest(request)
      );
    } else {
      revert UnsupportedTransactionType(decoded.txType);
    }
  }

  /// @notice Returns the config key used to look up target decimals for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getTargetDecimalsKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(
          HYPERLIQUID_VM_TARGET_DECIMALS_PREFIX,
          chainId,
          currency
        )
      );
  }

  /// @notice Returns the config key used to look up a currency symbol
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getCurrencySymbolKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(
          HYPERLIQUID_VM_CURRENCY_SYMBOL_PREFIX,
          chainId,
          currency
        )
      );
  }

  /// @notice Returns the config key used to look up source DEX for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getSourceDexKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(HYPERLIQUID_VM_SOURCE_DEX_PREFIX, chainId, currency)
      );
  }

  /// @notice Returns the config key used to look up destination DEX for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return key Config key
  function getDestinationDexKey(
    string calldata chainId,
    bytes calldata currency
  ) public pure returns (bytes32 key) {
    return
      keccak256(
        abi.encodePacked(
          HYPERLIQUID_VM_DESTINATION_DEX_PREFIX,
          chainId,
          currency
        )
      );
  }

  /// @notice Hashes a usdSend request according to Hyperliquid's EIP-712 schema
  /// @param request usdSend request to hash
  /// @return structHash EIP-712 struct hash
  function hashUsdSendRequest(
    UsdSendRequest memory request
  ) public pure returns (bytes32 structHash) {
    return
      keccak256(
        abi.encode(
          USD_SEND_TYPEHASH,
          keccak256(bytes(request.hyperliquidChain)),
          keccak256(bytes(request.destination)),
          keccak256(bytes(request.amount)),
          request.time
        )
      );
  }

  /// @notice Hashes a sendAsset request according to Hyperliquid's EIP-712 schema
  /// @param request sendAsset request to hash
  /// @return structHash EIP-712 struct hash
  function hashSendAssetRequest(
    SendAssetRequest memory request
  ) public pure returns (bytes32 structHash) {
    return
      keccak256(
        abi.encode(
          SEND_ASSET_TYPEHASH,
          keccak256(bytes(request.hyperliquidChain)),
          keccak256(bytes(request.destination)),
          keccak256(bytes(request.sourceDex)),
          keccak256(bytes(request.destinationDex)),
          keccak256(bytes(request.token)),
          keccak256(bytes(request.amount)),
          keccak256(bytes(request.fromSubAccount)),
          request.nonce
        )
      );
  }

  /// @notice Builds the usdSend request body
  /// @param chainId Relay chain id
  /// @param params Payload builder parameters supplied by the allocator
  /// @return request usdSend request
  function _buildUsdSendRequest(
    string calldata chainId,
    BuildPayloadParams calldata params
  ) internal view returns (UsdSendRequest memory request) {
    request.hyperliquidChain = hyperliquidChain;
    request.destination = _addressToString(address(bytes20(params.receiver)));
    request.amount = _formatAmount(
      params.amount,
      _getTargetDecimals(chainId, params.currency)
    );
    request.time = _deriveNonce(params.data);
  }

  /// @notice Builds the sendAsset request body
  /// @param chainId Relay chain id
  /// @param params Payload builder parameters supplied by the allocator
  /// @return request sendAsset request
  function _buildSendAssetRequest(
    string calldata chainId,
    BuildPayloadParams calldata params
  ) internal view returns (SendAssetRequest memory request) {
    request.nonce = _deriveNonce(params.data);
    request.sourceDex = _bytes32ToString(
      CONFIG.getConfigValue(getSourceDexKey(chainId, params.currency))
    );
    request.destinationDex = _bytes32ToString(
      CONFIG.getConfigValue(getDestinationDexKey(chainId, params.currency))
    );

    request.hyperliquidChain = hyperliquidChain;
    request.destination = _addressToString(address(bytes20(params.receiver)));
    request.token = string.concat(
      _bytes32ToString(
        CONFIG.getConfigValue(getCurrencySymbolKey(chainId, params.currency))
      ),
      ":",
      _bytesToHexString(params.currency)
    );
    request.amount = _formatAmount(
      params.amount,
      _getTargetDecimals(chainId, params.currency)
    );
    request.fromSubAccount = "";
  }

  /// @notice Derives a current-time Hyperliquid nonce from legacy nonce data
  /// @dev Keeps the millisecond component supplied by existing integrations while preventing users from selecting the timestamp
  /// @param data ABI-encoded uint64 nonce seed
  /// @return nonce Current block time in milliseconds plus the seed's millisecond component
  function _deriveNonce(
    bytes calldata data
  ) internal view returns (uint64 nonce) {
    uint64 nonceSeed = abi.decode(data, (uint64));
    return uint64(block.timestamp * 1000) + (nonceSeed % 1000);
  }

  /// @notice Returns the configured target decimals for a currency
  /// @param chainId Relay chain id
  /// @param currency Encoded currency
  /// @return decimals Configured target decimals
  function _getTargetDecimals(
    string calldata chainId,
    bytes calldata currency
  ) internal view returns (uint8 decimals) {
    decimals = uint8(
      uint256(CONFIG.getConfigValue(getTargetDecimalsKey(chainId, currency)))
    );
    if (decimals > MAX_TARGET_DECIMALS) {
      revert TargetDecimalsTooLarge(decimals);
    }
  }

  /// @notice Formats an amount as a Hyperliquid decimal string
  /// @param amount Amount in target-decimal units
  /// @param targetDecimals Number of decimals in the resulting string
  /// @return formatted Formatted amount string
  function _formatAmount(
    uint256 amount,
    uint8 targetDecimals
  ) internal pure returns (string memory formatted) {
    if (targetDecimals == 0) {
      return _uintToString(amount);
    }

    uint256 scale = 10 ** targetDecimals;
    uint256 integerPart = amount / scale;
    uint256 fractionalPart = amount % scale;

    return
      string.concat(
        _uintToString(integerPart),
        ".",
        _uintToFixedString(fractionalPart, targetDecimals)
      );
  }

  /// @notice Returns whether a currency encoding represents native Hyperliquid USDC
  /// @param currency Encoded currency
  /// @return isNative True if currency is exactly a zero-filled 16-byte id
  function _isNativeCurrency(
    bytes calldata currency
  ) internal pure returns (bool isNative) {
    if (currency.length != 16) {
      return false;
    }

    for (uint256 i; i < 16; ++i) {
      if (currency[i] != 0) {
        return false;
      }
    }
    return true;
  }

  /// @notice Converts an EVM-style address to a lowercase hex string
  /// @param account Address to convert
  /// @return out Hex string with 0x prefix
  function _addressToString(
    address account
  ) internal pure returns (string memory out) {
    return _bytesToHexString(abi.encodePacked(account));
  }

  /// @notice Converts bytes to a lowercase hex string
  /// @param data Bytes to convert
  /// @return out Hex string with 0x prefix
  function _bytesToHexString(
    bytes memory data
  ) internal pure returns (string memory out) {
    bytes16 symbols = "0123456789abcdef";
    bytes memory buffer = new bytes(2 + data.length * 2);
    buffer[0] = "0";
    buffer[1] = "x";
    for (uint256 i; i < data.length; ++i) {
      buffer[2 + i * 2] = symbols[uint8(data[i] >> 4)];
      buffer[3 + i * 2] = symbols[uint8(data[i] & 0x0f)];
    }
    return string(buffer);
  }

  /// @notice Converts a zero-padded bytes32 ASCII value to a string
  /// @param value Bytes32 value
  /// @return out String without trailing zero bytes
  function _bytes32ToString(
    bytes32 value
  ) internal pure returns (string memory out) {
    uint256 length;
    while (length < 32 && value[length] != 0) {
      ++length;
    }

    bytes memory buffer = new bytes(length);
    for (uint256 i; i < length; ++i) {
      buffer[i] = value[i];
    }
    return string(buffer);
  }

  /// @notice Converts an integer to a decimal string
  /// @param value Integer value
  /// @return out Decimal string
  function _uintToString(
    uint256 value
  ) internal pure returns (string memory out) {
    if (value == 0) {
      return "0";
    }

    uint256 temp = value;
    uint256 digits;
    while (temp != 0) {
      ++digits;
      temp /= 10;
    }

    bytes memory buffer = new bytes(digits);
    while (value != 0) {
      --digits;
      buffer[digits] = bytes1(uint8(48 + (value % 10)));
      value /= 10;
    }
    return string(buffer);
  }

  /// @notice Converts an integer to a zero-padded decimal string
  /// @param value Integer value
  /// @param length Desired string length
  /// @return out Decimal string padded on the left with zeroes
  function _uintToFixedString(
    uint256 value,
    uint8 length
  ) internal pure returns (string memory out) {
    bytes memory buffer = new bytes(length);
    for (uint256 i = length; i > 0; --i) {
      buffer[i - 1] = bytes1(uint8(48 + (value % 10)));
      value /= 10;
    }
    return string(buffer);
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "hyperliquid-vm";
  }
}
