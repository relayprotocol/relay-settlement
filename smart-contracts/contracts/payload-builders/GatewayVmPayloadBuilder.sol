// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "../Config.sol";
import {CircleGatewayCodec} from "./gateway/CircleGatewayCodec.sol";
import {BurnIntent, CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION, TransferSpec} from "./gateway/CircleGatewayTypes.sol";
import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {GasPaidPayloadBuilder} from "./GasPaidPayloadBuilder.sol";
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
/// A matching out-of-band gas payment compensates that shared balance before the payload is built.
contract GatewayVmPayloadBuilder is IPayloadBuilder, GasPaidPayloadBuilder {
    error InvalidCurrencyLength(uint256 length);
    error InvalidCurrency(address currency);
    error InvalidAmount();
    error InvalidMaxBlockHeight();
    error AllocatorNotAllowed(address allocator);
    error FeeExceedsPaidGas(uint256 maxFee, uint256 paidAmount);

    /// @notice Config contract containing Gateway policy, routing, and domain metadata
    Config public immutable CONFIG;

    bytes32 internal constant CIRCLE_DOMAIN_PREFIX = keccak256("GATEWAY_VM_CIRCLE_DOMAIN");
    bytes32 internal constant GAS_FEE_PREFIX = keccak256("GATEWAY_VM_GAS_FEE");
    bytes32 internal constant DOMAIN_TOKEN_PREFIX = keccak256("GATEWAY_VM_DOMAIN_TOKEN");
    bytes32 internal constant DESTINATION_BUILDER_PREFIX = keccak256("GATEWAY_VM_DESTINATION_BUILDER");
    bytes32 internal constant DESTINATION_DEPOSITORY_PREFIX = keccak256("GATEWAY_VM_DESTINATION_DEPOSITORY");
    bytes32 internal constant ALLOCATOR_ALLOWED_PREFIX = keccak256("GATEWAY_VM_ALLOCATOR_ALLOWED");

    /// @notice Circle's crosschain transfer fee is 0.5 basis points
    uint256 internal constant TRANSFER_FEE_DENOMINATOR = 20_000;

    /// @notice Creates a Gateway VM payload builder
    /// @param config Config contract address
    /// @param gasPayer WithdrawGasPayer contract whose payments authorize builds
    constructor(address config, address gasPayer) GasPaidPayloadBuilder(gasPayer) {
        CONFIG = Config(config);
    }

    /// @inheritdoc IPayloadBuilder
    /// @dev Reverts unless the withdrawer prepaid the exact request's Gateway fee, and unless
    /// the prepaid amount covers the maximum fee Circle may deduct from the source allocator.
    function buildPayload(string calldata chainId, bytes calldata depository, BuildPayloadParams calldata params)
        external
        view
        override
        returns (bytes memory payload)
    {
        uint256 paidAmount = _requireGasPaid(chainId, depository, params);

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

        GatewayVmRoutingData memory routing;
        routing.sourceDomain = uint32(uint256(CONFIG.getConfigValue(getCircleDomainKey(chainId))));
        routing.destinationDomain = uint32(uint256(CONFIG.getConfigValue(getCircleDomainKey(data.destinationChainId))));
        if (!_isEnabled(getAllocatorAllowedKey(data.allocator))) {
            revert AllocatorNotAllowed(data.allocator);
        }

        GatewayVmPayload memory gatewayPayload;
        gatewayPayload.destinationChainId = data.destinationChainId;
        routing.destinationBuilder = _getDestinationBuilder(data.destinationChainId);
        routing.destinationDepository = CONFIG.getConfigValue(getDestinationDepositoryKey(data.destinationChainId));
        bytes memory destinationDepositoryData = abi.encodePacked(routing.destinationDepository);
        bytes32 salt = keccak256(abi.encode(address(this), chainId, depository, params));
        gatewayPayload.burnIntent = _buildBurnIntent(chainId, data, routing, params, salt);
        if (gatewayPayload.burnIntent.maxFee > paidAmount) {
            revert FeeExceedsPaidGas(gatewayPayload.burnIntent.maxFee, paidAmount);
        }
        bytes32 transferSpecHash = CircleGatewayCodec.hashTransferSpec(gatewayPayload.burnIntent.spec);
        gatewayPayload.executionPayload = _buildExecutionPayload(
            routing.destinationBuilder,
            transferSpecHash,
            gatewayPayload.burnIntent.spec.destinationToken,
            destinationDepositoryData,
            data,
            params
        );

        return abi.encode(gatewayPayload);
    }

    /// @inheritdoc IPayloadBuilder
    function hashesToSign(string calldata, bytes calldata, bytes calldata payload)
        external
        view
        override
        returns (bytes32[] memory hashes)
    {
        GatewayVmPayload memory gatewayPayload = abi.decode(payload, (GatewayVmPayload));
        string memory destinationChainId = gatewayPayload.destinationChainId;
        bytes32 destinationDepository = CONFIG.getConfigValue(getDestinationDepositoryKey(destinationChainId));
        bytes memory destinationDepositoryData = abi.encodePacked(destinationDepository);
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

    /// @notice Returns the allocator allowlist key
    /// @param allocator Gateway balance owner and Circle BurnIntent signer
    /// @return The allocator allowlist config key
    function getAllocatorAllowedKey(address allocator) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(ALLOCATOR_ALLOWED_PREFIX, allocator));
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

    /// @notice Builds a Circle burn intent using source-domain fee policy
    /// @param chainId Relay Gateway chain id
    /// @param data Gateway payload data
    /// @param routing Resolved Gateway routing config
    /// @param params Allocator payload parameters
    /// @return intent Deterministic Circle burn intent
    function _buildBurnIntent(
        string calldata chainId,
        GatewayVmPayloadData memory data,
        GatewayVmRoutingData memory routing,
        BuildPayloadParams calldata params,
        bytes32 salt
    ) private view returns (BurnIntent memory intent) {
        uint256 maxFee = uint256(CONFIG.getConfigValue(getGasFeeKey(chainId)));
        if (routing.sourceDomain != routing.destinationDomain) {
            maxFee += params.amount / TRANSFER_FEE_DENOMINATOR;
            if (params.amount % TRANSFER_FEE_DENOMINATOR != 0) {
                ++maxFee;
            }
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
                sourceToken: CONFIG.getConfigValue(getDomainTokenKey(chainId)),
                destinationToken: CONFIG.getConfigValue(getDomainTokenKey(data.destinationChainId)),
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
        BuildPayloadParams calldata params
    ) private view returns (bytes memory payload) {
        return destinationBuilder.buildExecutionPayload(
            GatewayExecutionParams({
                destinationChainId: data.destinationChainId,
                transferSpecHash: transferSpecHash,
                destinationToken: destinationToken,
                depository: depository,
                receiver: params.receiver,
                amount: params.amount,
                nonce: params.nonce,
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
    /// @param key Allowlist config key
    /// @return True when the key exists and contains a non-zero value
    function _isEnabled(bytes32 key) private view returns (bool) {
        try CONFIG.getConfigValue(key) returns (bytes32 value) {
            return value != bytes32(0);
        } catch {
            return false;
        }
    }
}
