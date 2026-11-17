// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Config} from "../Config.sol";
import {CircleGatewayCodec} from "./gateway/CircleGatewayCodec.sol";
import {BurnIntent, CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION, TransferSpec} from "./gateway/CircleGatewayTypes.sol";
import {IPayloadBuilder, WithdrawRequest, WithdrawFee} from "../RelayAllocator.sol";
import {
    GatewayExecutionParams,
    IGatewayDestinationPayloadBuilder
} from "./gateway/IGatewayDestinationPayloadBuilder.sol";

/// @notice Additional data supplied when requesting a Gateway withdrawal
struct GatewayVmPayloadData {
    address allocator;
    string destinationChainId;
    uint256 maxBlockHeight;
    bytes destinationData; /// @notice Opaque parameters interpreted by the destination builder
}

/// @notice VM-neutral Gateway withdrawal payload stored by the RelayAllocator
struct GatewayVmPayload {
    string destinationChainId;
    bytes executionPayload;
    BurnIntent burnIntent;
}

/// @notice Resolved Gateway routing config for a withdrawal
struct GatewayVmRoutingData {
    uint32 sourceDomain;
    uint32 destinationDomain;
    bytes32 destinationDepository;
    IGatewayDestinationPayloadBuilder destinationBuilder;
}

/// @title GatewayVmPayloadBuilder
/// @author Relay Protocol
/// @notice Builds Circle burn intents and dispatches execution payloads by destination VM type
/// @dev Circle deducts the BurnIntent fee from the source allocator's Gateway balance.
/// The allocator collects the reported maximum fee from an oracle-authorized payer.
contract GatewayVmPayloadBuilder is IPayloadBuilder {
    error InvalidCurrencyLength(uint256 length);
    error InvalidCurrency(address currency);
    error InvalidAmount();
    error InvalidTransferFeePpm(uint256 feePpm);
    error InvalidMaxBlockHeight();
    error AllocatorNotAllowed(address allocator);
    error DestinationDepositoryNotSet(string destinationChainId);
    error DomainTokenNotSet(string chainId);

    /// @notice Config contract containing Gateway policy, routing, and domain metadata
    Config public immutable CONFIG;

    bytes32 internal constant CIRCLE_DOMAIN_PREFIX = keccak256("GATEWAY_VM_CIRCLE_DOMAIN");
    bytes32 internal constant GAS_FEE_PREFIX = keccak256("GATEWAY_VM_GAS_FEE");
    bytes32 internal constant MAX_BLOCK_HEIGHT_PREFIX = keccak256("GATEWAY_VM_MAX_BLOCK_HEIGHT");
    bytes32 internal constant SOURCE_TRANSFER_FEE_PPM_PREFIX = keccak256("GATEWAY_VM_SOURCE_TRANSFER_FEE_PPM");
    bytes32 internal constant DOMAIN_TOKEN_PREFIX = keccak256("GATEWAY_VM_DOMAIN_TOKEN");
    bytes32 internal constant DESTINATION_BUILDER_PREFIX = keccak256("GATEWAY_VM_DESTINATION_BUILDER");
    bytes32 internal constant DESTINATION_DEPOSITORY_PREFIX = keccak256("GATEWAY_VM_DESTINATION_DEPOSITORY");
    bytes32 internal constant ALLOCATOR_ALLOWED_PREFIX = keccak256("GATEWAY_VM_ALLOCATOR_ALLOWED");

    /// @notice Default crosschain transfer fee: 50 parts per million (0.5 basis points)
    uint256 internal constant DEFAULT_TRANSFER_FEE_PPM = 50;
    uint256 internal constant TRANSFER_FEE_DENOMINATOR = 1_000_000;

    /// @notice Creates a Gateway VM payload builder
    /// @param config Config contract address
    constructor(address config) {
        CONFIG = Config(config);
    }

    /// @inheritdoc IPayloadBuilder
    /// @dev Reverts unless the withdrawer prepaid the exact request's Gateway fee, and unless
    /// the prepaid amount covers the maximum fee Circle may deduct from the source allocator.
    function buildPayload(string calldata chainId, bytes calldata /* depository */, WithdrawRequest calldata params)
        external
        view
        override
        returns (bytes memory payload, WithdrawFee memory withdrawFee)
    {
        if (params.currency.length != 20) {
            revert InvalidCurrencyLength(params.currency.length);
        }

        address currency = address(bytes20(params.currency));
        if (currency != address(0)) {
            revert InvalidCurrency(currency);
        }
        if (params.amount == 0) {
            revert InvalidAmount();
        }

        GatewayVmPayloadData memory data = abi.decode(params.data, (GatewayVmPayloadData));
        if (data.maxBlockHeight == 0) {
            revert InvalidMaxBlockHeight();
        }
        {
            (bool hasCeiling, uint256 ceiling) = _getOptionalConfigValue(getMaxBlockHeightKey(chainId));
            if (hasCeiling && data.maxBlockHeight > ceiling) {
                revert InvalidMaxBlockHeight();
            }
        }

        GatewayVmRoutingData memory routing;
        routing.sourceDomain = uint32(uint256(CONFIG.getConfigValue(getCircleDomainKey(chainId))));
        routing.destinationDomain = uint32(uint256(CONFIG.getConfigValue(getCircleDomainKey(data.destinationChainId))));
        if (!_isEnabled(getAllocatorAllowedKey(chainId, data.allocator))) {
            revert AllocatorNotAllowed(data.allocator);
        }

        GatewayVmPayload memory gatewayPayload;
        gatewayPayload.destinationChainId = data.destinationChainId;
        routing.destinationBuilder = _getDestinationBuilder(data.destinationChainId);
        routing.destinationDepository = CONFIG.getConfigValue(getDestinationDepositoryKey(data.destinationChainId));
        if (routing.destinationDepository == bytes32(0)) {
            revert DestinationDepositoryNotSet(data.destinationChainId);
        }
        bytes memory destinationDepositoryData = abi.encodePacked(routing.destinationDepository);
        bytes32 salt = keccak256(abi.encode(address(this), params));
        gatewayPayload.burnIntent = _buildBurnIntent(chainId, data, routing, params, salt);
        bytes32 transferSpecHash = CircleGatewayCodec.hashTransferSpec(gatewayPayload.burnIntent.spec);
        gatewayPayload.executionPayload = _buildExecutionPayload(
            routing.destinationBuilder,
            transferSpecHash,
            gatewayPayload.burnIntent.spec.destinationToken,
            destinationDepositoryData,
            data,
            params
        );

        return (abi.encode(gatewayPayload), WithdrawFee(params.currency, gatewayPayload.burnIntent.maxFee));
    }

    /// @inheritdoc IPayloadBuilder
    /// @dev The destination depository is taken from the payload's BurnIntent, not live Config
    function hashesToSign(string calldata, bytes calldata, bytes calldata payload)
        external
        view
        override
        returns (bytes32[] memory hashes)
    {
        GatewayVmPayload memory gatewayPayload = abi.decode(payload, (GatewayVmPayload));
        string memory destinationChainId = gatewayPayload.destinationChainId;
        bytes memory destinationDepositoryData = abi.encodePacked(gatewayPayload.burnIntent.spec.destinationRecipient);
        IGatewayDestinationPayloadBuilder destinationBuilder = _getDestinationBuilder(destinationChainId);

        hashes = new bytes32[](2);
        hashes[0] = CircleGatewayCodec.hashBurnIntent(gatewayPayload.burnIntent);
        hashes[1] = destinationBuilder.hashExecutionPayload(
            destinationChainId, destinationDepositoryData, gatewayPayload.executionPayload
        );
    }

    /// @notice Returns the Circle domain key for a Relay chain
    /// @param chainId Relay chain id
    /// @return The Circle domain config key
    function getCircleDomainKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(CIRCLE_DOMAIN_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the fixed Circle gas-fee key for a Gateway chain
    /// @param chainId Relay Gateway chain id
    /// @return The gas-fee config key
    function getGasFeeKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(GAS_FEE_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the inclusive source block-height ceiling key for a Gateway chain
    /// @dev Unset preserves unbounded nonzero heights; explicit zero disables new payloads.
    /// The owner must refresh a configured ceiling using the source chain's height.
    /// @param chainId Relay Gateway source chain id
    /// @return The maximum burn-intent block-height config key
    function getMaxBlockHeightKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(MAX_BLOCK_HEIGHT_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the source transfer-fee override key, in parts per million
    /// @dev Unset falls back to 50 ppm; explicit zero waives the percentage fee.
    /// Rates must be at most 1,000,000 ppm (100%). Same-domain transfers always waive the
    /// percentage fee; the fixed gas fee still applies.
    /// @param chainId Relay Gateway source chain id (e.g. "arc-gateway")
    /// @return The source transfer-fee config key
    function getSourceTransferFeeKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(SOURCE_TRANSFER_FEE_PPM_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the token or mint key for a Relay chain
    /// @param chainId Relay chain id
    /// @return The domain-token config key
    function getDomainTokenKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(DOMAIN_TOKEN_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the destination builder key for a Relay chain
    /// @param destinationChainId Relay destination chain id
    /// @return The destination-builder config key
    function getDestinationBuilderKey(string memory destinationChainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(DESTINATION_BUILDER_PREFIX, keccak256(bytes(destinationChainId))));
    }

    /// @notice Returns the destination depository key for a Relay chain
    /// @param chainId Relay destination chain id
    /// @return The destination-depository config key
    function getDestinationDepositoryKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(DESTINATION_DEPOSITORY_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the allocator allowlist key for a Gateway source chain
    /// @param chainId Relay Gateway source chain id
    /// @param allocator Gateway balance owner and Circle BurnIntent signer
    /// @return The allocator allowlist config key
    function getAllocatorAllowedKey(string memory chainId, address allocator) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(ALLOCATOR_ALLOWED_PREFIX, keccak256(bytes(chainId)), allocator));
    }

    /// @inheritdoc IPayloadBuilder
    /// @dev Gateway payloads can require different curves per returned hash
    function curve() external pure override returns (string memory name) {
        return "Ecdsa/Eddsa";
    }

    /// @inheritdoc IPayloadBuilder
    function family() external pure override returns (string memory name) {
        return "gateway-vm";
    }

    /// @notice Builds a Circle burn intent using the configured source fee policy
    /// @param chainId Relay Gateway chain id
    /// @param data Gateway payload data
    /// @param routing Resolved Gateway routing config
    /// @param params Allocator payload parameters
    /// @return intent Deterministic Circle burn intent
    function _buildBurnIntent(
        string calldata chainId,
        GatewayVmPayloadData memory data,
        GatewayVmRoutingData memory routing,
        WithdrawRequest calldata params,
        bytes32 salt
    ) private view returns (BurnIntent memory intent) {
        uint256 maxFee = uint256(CONFIG.getConfigValue(getGasFeeKey(chainId)));
        if (routing.sourceDomain != routing.destinationDomain) {
            uint256 feePpm = _getTransferFeePpm(chainId);
            maxFee += Math.mulDiv(params.amount, feePpm, TRANSFER_FEE_DENOMINATOR, Math.Rounding.Ceil);
        }

        return BurnIntent({
            maxBlockHeight: data.maxBlockHeight,
            maxFee: maxFee,
            spec: TransferSpec({
                version: CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION,
                sourceDomain: routing.sourceDomain,
                destinationDomain: routing.destinationDomain,
                sourceContract: routing.destinationBuilder.sourceContract(),
                destinationContract: routing.destinationBuilder.destinationContract(),
                sourceToken: _getDomainToken(chainId),
                destinationToken: _getDomainToken(data.destinationChainId),
                sourceDepositor: CircleGatewayCodec.addressToBytes32(data.allocator),
                destinationRecipient: routing.destinationDepository,
                sourceSigner: CircleGatewayCodec.addressToBytes32(data.allocator),
                destinationCaller: routing.destinationDepository,
                value: params.amount,
                salt: salt,
                hookData: ""
            })
        });
    }

    /// @notice Resolves a chain's Circle-encoded token, rejecting a zeroed (revoked) key
    /// @param chainId Relay chain id
    /// @return token Circle-encoded token or mint
    function _getDomainToken(string memory chainId) private view returns (bytes32 token) {
        token = CONFIG.getConfigValue(getDomainTokenKey(chainId));
        if (token == bytes32(0)) {
            revert DomainTokenNotSet(chainId);
        }
    }

    /// @notice Resolves the source crosschain percentage fee, defaulting to 50 ppm
    /// @return feePpm Fee in parts per million, bounded to 100%
    function _getTransferFeePpm(string memory sourceChainId) private view returns (uint256 feePpm) {
        (bool exists, uint256 value) = _getOptionalConfigValue(getSourceTransferFeeKey(sourceChainId));
        feePpm = exists ? value : DEFAULT_TRANSFER_FEE_PPM;
        if (feePpm > TRANSFER_FEE_DENOMINATOR) {
            revert InvalidTransferFeePpm(feePpm);
        }
    }

    /// @notice Reads an optional config value, distinguishing an unset key from an explicit zero
    /// @dev Only ConfigValueNotSet for the requested key permits fallback; other failures propagate.
    /// @return exists Whether the value was configured
    /// @return configuredValue Configured value interpreted as an unsigned integer
    function _getOptionalConfigValue(bytes32 key) private view returns (bool exists, uint256 configuredValue) {
        try CONFIG.getConfigValue(key) returns (bytes32 value) {
            return (true, uint256(value));
        } catch (bytes memory reason) {
            if (keccak256(reason) != keccak256(abi.encodeWithSelector(Config.ConfigValueNotSet.selector, key))) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            return (false, 0);
        }
    }

    /// @notice Delegates execution-payload construction to the destination VM adapter
    /// @param destinationBuilder Configured destination VM adapter
    /// @param transferSpecHash Circle transfer-spec hash to bind
    /// @param destinationToken Circle-encoded destination token
    /// @param depository VM-specific encoded destination depository
    /// @param data Gateway payload data including destination-specific parameters
    /// @param params Allocator payload parameters
    /// @return payload VM-specific execution payload
    function _buildExecutionPayload(
        IGatewayDestinationPayloadBuilder destinationBuilder,
        bytes32 transferSpecHash,
        bytes32 destinationToken,
        bytes memory depository,
        GatewayVmPayloadData memory data,
        WithdrawRequest calldata params
    ) private view returns (bytes memory payload) {
        return destinationBuilder.buildExecutionPayload(
            GatewayExecutionParams({
                destinationChainId: data.destinationChainId,
                transferSpecHash: transferSpecHash,
                destinationToken: destinationToken,
                depository: depository,
                receiver: params.receiver,
                amount: params.amount,
                nonce: uint256(params.nonce),
                expiration: block.timestamp + destinationBuilder.getExpirationDelay(),
                data: data.destinationData
            })
        );
    }

    /// @notice Resolves a destination builder by Relay destination chain id
    /// @param destinationChainId Relay destination chain id
    /// @return builder Configured destination payload builder
    function _getDestinationBuilder(string memory destinationChainId)
        private
        view
        returns (IGatewayDestinationPayloadBuilder builder)
    {
        bytes32 configuredBuilder = CONFIG.getConfigValue(getDestinationBuilderKey(destinationChainId));
        return IGatewayDestinationPayloadBuilder(address(uint160(uint256(configuredBuilder))));
    }

    /// @notice Reads an allowlist flag, treating unset keys as disabled
    /// @dev `1` allows, anything else does not, matching the router allowlists
    /// @param key Allowlist config key
    /// @return True when the key exists and contains exactly 1
    function _isEnabled(bytes32 key) private view returns (bool) {
        try CONFIG.getConfigValue(key) returns (bytes32 value) {
            return value == bytes32(uint256(1));
        } catch {
            return false;
        }
    }
}
