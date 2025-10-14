// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPayloadBuilder} from "../RelayAllocator.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Utils} from "../Utils.sol";

/// @title IRelayAllocator
/// @notice Interface for RelayAllocator contract
// solhint-disable-next-line use-natspec
interface IRelayAllocator {
  /// @notice Returns the owner address of the RelayAllocator contract
  /// @return The address of the contract owner
  function owner() external view returns (address);
}

/// @title HyperLiquid Transaction Structures
/// @notice Defines the structures used for HyperLiquid transactions

/// @notice Request structure for USD transfers on HyperLiquid
struct UsdSendRequest {
  string hyperliquidChain;
  string destination;
  string amount;
  uint64 time;
}

/// @notice Request structure for spot token transfers on HyperLiquid
struct SpotSendRequest {
  string hyperliquidChain;
  string destination;
  string token;
  string amount;
  uint64 time;
}

/// @notice Request structure for asset sends on HyperLiquid
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

/// @notice Transaction type enum for better extensibility
enum HyperLiquidTxType {
  UsdSend,
  SpotSend,
  SendAsset
}

/// @notice Unified transaction structure for all HyperLiquid operations
struct HyperLiquidTx {
  HyperLiquidTxType txType;
  bytes parameters; // Encoded parameters for the specific transaction type
}

/// @title HyperLiquidPayloadBuilder
/// @author Relay Protocol
/// @notice Implements the logic to build payloads for HyperLiquid transactions
contract HyperLiquidPayloadBuilder is IPayloadBuilder {
  // Custom errors
  /// @notice Thrown when an invalid transaction type is provided
  error InvalidTransactionType(uint8 txType);
  /// @notice Thrown when invalid data is provided
  error InvalidData();
  /// @notice Thrown when invalid decimal configuration is used
  error InvalidDecimals();
  /// @notice Thrown when amount precision is not integral at target decimals
  error NonIntegralAtPrecision();
  /// @notice Thrown when caller is not the allocator owner
  error NotRelayAllocatorOwner(address account);
  /// @notice Thrown when DEX is not whitelisted
  error InvalidDEX();

  // EIP712 domain configuration
  /// @notice The signing domain for EIP712
  string public constant EIP712_DOMAIN_NAME = "HyperliquidSignTransaction";
  /// @notice The signature version for EIP712
  string public constant EIP712_DOMAIN_VERSION = "1";

  // EIP712 type hashes
  /// @notice EIP-712 typehash for UsdSend struct
  bytes32 public constant USD_SEND_TYPEHASH =
    keccak256(
      "HyperliquidTransaction:UsdSend(string hyperliquidChain,string destination,string amount,uint64 time)"
    );

  /// @notice EIP-712 typehash for SpotSend struct
  bytes32 public constant SPOT_SEND_TYPEHASH =
    keccak256(
      "HyperliquidTransaction:SpotSend(string hyperliquidChain,string destination,string token,string amount,uint64 time)"
    );

  /// @notice EIP-712 typehash for SendAsset struct
  bytes32 public constant SEND_ASSET_TYPEHASH =
    keccak256(
      "HyperliquidTransaction:SendAsset(string hyperliquidChain,string destination,string sourceDex,string destinationDex,string token,string amount,string fromSubAccount,uint64 nonce)"
    );

  // Configuration
  /// @notice The HyperLiquid chain to use (e.g., "Mainnet", "Testnet")
  string public hyperliquidChain;

  /// @notice Mapping from currency to target decimals for secure decimal handling
  mapping(string => uint8) public targetDecimals;

  /// @notice Whether to use the new `SendAsset` request
  bool public useSendAsset;

  /// @notice DEX whitelist for source and destination DEX validation
  mapping(string => bool) public dexWhitelist;

  /// @notice RelayAllocator contract instance
  IRelayAllocator public allocator;

  /// @notice Constructor that initializes the payload builder with a HyperLiquid chain
  /// @param _hyperliquidChain The HyperLiquid chain to use (e.g., "Mainnet", "Testnet")
  /// @param _allocator The RelayAllocator contract address
  constructor(string memory _hyperliquidChain, IRelayAllocator _allocator) {
    hyperliquidChain = _hyperliquidChain;
    allocator = _allocator;

    // Set default decimals for Core USDC
    targetDecimals[""] = 2;
  }

  /// @notice Modifier to restrict access to allocator owner only
  modifier onlyAllocatorOwner() {
    if (msg.sender != allocator.owner())
      revert NotRelayAllocatorOwner(msg.sender);
    _;
  }

  /// @notice Sets the target decimals for a specific currency
  /// @param currency The currency identifier
  /// @param decimals The number of decimal places for this currency
  function setTargetDecimals(
    string calldata currency,
    uint8 decimals
  ) public onlyAllocatorOwner {
    if (decimals > 18) revert InvalidDecimals();
    targetDecimals[currency] = decimals;
  }

  /// @notice Sets the value of the `useSendAsset` field
  /// @param use The value to set
  function setUseSendAsset(bool use) external onlyAllocatorOwner {
    useSendAsset = use;
  }

  /// @notice Sets the whitelist status for a DEX
  /// @param dex The DEX identifier
  /// @param whitelisted Whether the DEX should be whitelisted
  function setDexWhitelist(
    string calldata dex,
    bool whitelisted
  ) external onlyAllocatorOwner {
    dexWhitelist[dex] = whitelisted;
  }

  /// @notice Builds a payload for HyperLiquid transactions
  /// @param currency Token currency (empty string for USD, token identifier for spots)
  /// @param amount Token amount in 18 decimal precision
  /// @param receiver Destination address for the transfer
  /// @param data ABI-encoded uint64 currentTime
  /// @return Encoded HyperLiquidTx containing the transaction data
  function buildPayload(
    uint256 /* chainId */,
    string calldata /* depository */,
    string calldata currency,
    uint256 amount,
    string memory receiver,
    bytes calldata data
  ) external view override returns (bytes memory) {
    // Parse currentTime from data parameter
    uint64 currentTime;
    if (data.length == 0) {
      revert InvalidData();
    } else {
      // Decode provided currentTime only
      currentTime = abi.decode(data, (uint64));
    }

    // Determine target decimals based on currency
    uint8 decimalsToUse = targetDecimals[currency];

    // Use default decimals if not configured
    if (decimalsToUse == 0) {
      revert InvalidDecimals();
    }

    // Convert amount to string with target decimal precision
    string memory amountStr = toDecimalString18(amount, decimalsToUse);

    HyperLiquidTx memory transaction;

    if (useSendAsset) {
      (, string memory sourceDex, string memory destinationDex) = abi.decode(
        data,
        (uint64, string, string)
      );

      // Validate DEX whitelist
      if (!dexWhitelist[sourceDex] || !dexWhitelist[destinationDex]) {
        revert InvalidDEX();
      }

      SendAssetRequest memory request = SendAssetRequest({
        hyperliquidChain: hyperliquidChain,
        destination: receiver,
        sourceDex: sourceDex,
        destinationDex: destinationDex,
        token: currency,
        amount: amountStr,
        fromSubAccount: "",
        nonce: currentTime
      });

      transaction.txType = HyperLiquidTxType.SendAsset;
      transaction.parameters = abi.encode(request);
    } else {
      bool isCoreUsdTransfer = bytes(currency).length == 0;
      if (isCoreUsdTransfer) {
        // Core USD transfer
        UsdSendRequest memory request = UsdSendRequest({
          hyperliquidChain: hyperliquidChain,
          destination: receiver,
          amount: amountStr,
          time: currentTime
        });

        transaction.txType = HyperLiquidTxType.UsdSend;
        transaction.parameters = abi.encode(request);
      } else {
        // Spot transfer - use the currency string directly
        SpotSendRequest memory request = SpotSendRequest({
          hyperliquidChain: hyperliquidChain,
          destination: receiver,
          token: currency, // Use the currency string directly (e.g., "PURR:0xc1fb593aeffbeb02f85e0308e9956a90")
          amount: amountStr,
          time: currentTime
        });

        transaction.txType = HyperLiquidTxType.SpotSend;
        transaction.parameters = abi.encode(request);
      }
    }

    return abi.encode(transaction);
  }

  /// @notice Returns the EIP-712 hashes to sign for the given payload
  /// @param chainId The chain ID for the domain separator
  /// @param payload The encoded payload to hash
  /// @return An array of EIP-712 hashes to sign
  function hashToSign(
    uint256 chainId,
    string calldata /* depository */,
    bytes calldata payload,
    uint32 /* hashIndex */
  ) external pure returns (bytes32) {
    // Decode the payload to determine the transaction type
    HyperLiquidTx memory transaction = abi.decode(payload, (HyperLiquidTx));

    bytes32 domainSeparator = Utils.buildDomainSeparator(
      EIP712_DOMAIN_NAME,
      EIP712_DOMAIN_VERSION,
      chainId,
      address(0)
    );

    if (transaction.txType == HyperLiquidTxType.UsdSend) {
      UsdSendRequest memory request = abi.decode(
        transaction.parameters,
        (UsdSendRequest)
      );
      return hashUsdSendRequest(request, domainSeparator);
    } else if (transaction.txType == HyperLiquidTxType.SpotSend) {
      SpotSendRequest memory request = abi.decode(
        transaction.parameters,
        (SpotSendRequest)
      );
      return hashSpotSendRequest(request, domainSeparator);
    } else if (transaction.txType == HyperLiquidTxType.SendAsset) {
      SendAssetRequest memory request = abi.decode(
        transaction.parameters,
        (SendAssetRequest)
      );
      return hashSendAssetRequest(request, domainSeparator);
    } else {
      // Unknown transaction type
      revert InvalidTransactionType(uint8(transaction.txType));
    }
  }

  /// @notice Helper function to hash a UsdSendRequest and return the EIP-712 digest
  /// @param request The UsdSendRequest to hash
  /// @param domainSeparator The domain separator
  /// @return The EIP712 hash
  function hashUsdSendRequest(
    UsdSendRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32) {
    bytes32 structHash = keccak256(
      abi.encode(
        USD_SEND_TYPEHASH,
        keccak256(bytes(request.hyperliquidChain)),
        keccak256(bytes(request.destination)),
        keccak256(bytes(request.amount)),
        request.time
      )
    );

    return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }

  /// @notice Helper function to hash a SpotSendRequest and return the EIP-712 digest
  /// @param request The SpotSendRequest to hash
  /// @param domainSeparator The domain separator
  /// @return The EIP712 hash
  function hashSpotSendRequest(
    SpotSendRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32) {
    bytes32 structHash = keccak256(
      abi.encode(
        SPOT_SEND_TYPEHASH,
        keccak256(bytes(request.hyperliquidChain)),
        keccak256(bytes(request.destination)),
        keccak256(bytes(request.token)),
        keccak256(bytes(request.amount)),
        request.time
      )
    );

    return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }

  /// @notice Helper function to hash a SendAssetRequest and return the EIP-712 digest
  /// @param request The SendAssetRequest to hash
  /// @param domainSeparator The domain separator
  /// @return The EIP712 hash
  function hashSendAssetRequest(
    SendAssetRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32) {
    bytes32 structHash = keccak256(
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

    return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }

  /// @notice Returns the curve used for signatures
  /// @return The curve name
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  /// @notice Returns the VM family
  /// @return The VM family name
  function family() external pure returns (string memory) {
    return "hyperliquid-vm";
  }

  /// @notice Converts an 18-decimal precision amount to a decimal string with the specified precision
  /// @dev Reverts with InvalidDecimals if `decimalsToShow` > 18.
  /// @param amount The amount in 18-decimal precision (wei).
  /// @param decimalsToShow Number of decimal places to show (0–18).
  /// @return The formatted decimal string (e.g., "100.00" for 2 decimal places).
  function toDecimalString18(
    uint256 amount,
    uint8 decimalsToShow
  ) public pure returns (string memory) {
    if (decimalsToShow > 18) revert InvalidDecimals();

    // Handle integer-only case (no decimal places)
    if (decimalsToShow == 0) {
      return Strings.toString(amount / 1e18);
    }

    // Calculate scaling factor to reduce precision from 18 to target decimals
    uint256 precisionScale = 10 ** (18 - decimalsToShow);
    // Strict mode: ensure precision consistency
    if (amount % precisionScale != 0) revert NonIntegralAtPrecision();

    // Scale down from 18 decimals to target decimal precision
    uint256 scaledToTarget = amount / precisionScale;
    uint256 decimalDivisor = 10 ** decimalsToShow;
    uint256 integerPart = scaledToTarget / decimalDivisor;
    uint256 fractionalPart = scaledToTarget % decimalDivisor;

    string memory integerString = Strings.toString(integerPart);

    // Handle case where fractional part is zero
    if (fractionalPart == 0) {
      // Preserve decimal format by adding zeros
      bytes memory resultWithZeros = new bytes(
        bytes(integerString).length + 1 + decimalsToShow
      );
      uint256 writePosition;

      // Copy integer part
      for (
        writePosition = 0;
        writePosition < bytes(integerString).length;
        writePosition++
      ) {
        resultWithZeros[writePosition] = bytes(integerString)[writePosition];
      }

      // Add decimal point
      resultWithZeros[writePosition++] = ".";

      // Add zeros for decimal places
      for (uint256 zeroIndex = 0; zeroIndex < decimalsToShow; zeroIndex++) {
        resultWithZeros[writePosition + zeroIndex] = "0";
      }

      return string(resultWithZeros);
    }

    // Convert fractional part to string and pad with leading zeros if needed
    bytes memory fractionalString = bytes(Strings.toString(fractionalPart));

    // Pad fractional part with leading zeros to match target decimal places
    if (fractionalString.length < decimalsToShow) {
      bytes memory paddedFractional = new bytes(decimalsToShow);
      uint256 paddingLength = decimalsToShow - fractionalString.length;

      // Add leading zeros
      for (uint256 padIndex = 0; padIndex < paddingLength; padIndex++) {
        paddedFractional[padIndex] = "0";
      }

      // Copy actual fractional digits
      for (
        uint256 fracIndex = 0;
        fracIndex < fractionalString.length;
        fracIndex++
      ) {
        paddedFractional[paddingLength + fracIndex] = fractionalString[
          fracIndex
        ];
      }

      fractionalString = paddedFractional;
    }

    // Preserve all decimal places (no trimming)
    uint256 effectiveLength = fractionalString.length;

    // Combine integer and fractional parts with decimal point
    bytes memory finalResult = new bytes(
      bytes(integerString).length + 1 + effectiveLength
    );
    uint256 position;

    // Copy integer part
    for (position = 0; position < bytes(integerString).length; position++) {
      finalResult[position] = bytes(integerString)[position];
    }

    // Add decimal point
    finalResult[position++] = ".";

    // Copy fractional part (up to effective length)
    for (uint256 fracIndex = 0; fracIndex < effectiveLength; fracIndex++) {
      finalResult[position + fracIndex] = fractionalString[fracIndex];
    }

    return string(finalResult);
  }
}
