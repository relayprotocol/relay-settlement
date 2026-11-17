// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "../../Config.sol";
import {Utils} from "../../Utils.sol";
import {SolanaRoutedWithdrawalData} from "../SolanaVmPayloadBuilder.sol";
import {GatewayExecutionParams, IGatewayDestinationPayloadBuilder} from "./IGatewayDestinationPayloadBuilder.sol";

/// @title GatewaySolanaVmDestinationPayloadBuilder
/// @author Relay Protocol
/// @notice Builds and hashes Gateway transfer requests for the Solana Gateway depository program
contract GatewaySolanaVmDestinationPayloadBuilder is IGatewayDestinationPayloadBuilder {
    /// @notice Thrown when a provided value does not fit into uint64
    /// @param value Provided value
    error ValueExceedsUint64(uint256 value);

    /// @notice Thrown when the expiration does not fit into int64
    /// @param expiration Provided expiration
    error ExpirationExceedsInt64(uint256 expiration);

    /// @notice Thrown when an encoded address does not have the expected length
    /// @param length Actual encoded length
    /// @param expectedLength Expected encoded length
    error InvalidAddressLength(uint256 length, uint256 expectedLength);

    /// @notice Thrown when routed withdrawal data has an unsupported version
    /// @param version Actual encoded version
    error UnsupportedRoutedDataVersion(uint8 version);

    /// @notice Thrown when the router is not allowlisted for the chain and depository
    /// @param router Router program id
    error RouterNotAllowed(bytes32 router);

    /// @notice Circle GatewayWallet shared by supported EVM source chains
    bytes32 public constant GATEWAY_WALLET = 0x00000000000000000000000077777777dcc4d5a8b6e418fd04d8997ef11000ee;
    /// @notice Circle GatewayMinter program on Solana (GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ)
    bytes32 public constant GATEWAY_MINTER = 0xe14b329dba52e324a7a85f52d16d7ef309ff24aa5d7421b0316b568c0e27d78c;

    /// @notice Config contract containing Gateway and standard solana-vm metadata
    Config public immutable CONFIG;

    bytes32 internal constant GATEWAY_SOLANA_VM_DOMAIN_PREFIX = keccak256("GATEWAY_SOLANA_VM_DOMAIN");
    bytes32 internal constant SOLANA_VM_EXPIRATION_KEY = keccak256("SOLANA_VM_EXPIRATION");
    bytes32 internal constant SOLANA_VM_ROUTER_ALLOWED_PREFIX = keccak256("SOLANA_VM_ROUTER_ALLOWED");

    /// @notice Type prefix of a transfer request
    bytes public constant TRANSFER_REQUEST_PREFIX = "RelayGatewayDepository:TransferRequest:v1";
    /// @notice Type prefix of a routed transfer request, which the depository only executes via the router
    bytes public constant ROUTED_TRANSFER_REQUEST_PREFIX = "RelayGatewayDepository:RoutedTransferRequest:v1";

    /// @notice Supported routed withdrawal data version
    uint8 public constant ROUTED_WITHDRAWAL_DATA_VERSION = 1;

    /// @notice Creates a Solana destination payload builder
    /// @param config Config contract address
    constructor(address config) {
        CONFIG = Config(config);
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    function sourceContract() external pure returns (bytes32) {
        return GATEWAY_WALLET;
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    function destinationContract() external pure returns (bytes32) {
        return GATEWAY_MINTER;
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    function getExpirationDelay() external view returns (uint256) {
        return uint256(CONFIG.getConfigValue(getExpirationKey()));
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    /// @dev Empty `params.data` builds a transfer request; routed data builds a routed one naming the router.
    /// Either payload is the type prefix followed by the Borsh-encoded request
    function buildExecutionPayload(GatewayExecutionParams calldata params)
        external
        view
        returns (bytes memory payload)
    {
        if (params.receiver.length != 32) {
            revert InvalidAddressLength(params.receiver.length, 32);
        }
        if (params.amount > type(uint64).max) {
            revert ValueExceedsUint64(params.amount);
        }
        if (params.expiration > uint64(type(int64).max)) {
            revert ExpirationExceedsInt64(params.expiration);
        }

        payload = bytes.concat(
            CONFIG.getConfigValue(getDomainKey(params.destinationChainId)),
            params.transferSpecHash,
            bytes32(params.receiver),
            params.destinationToken,
            Utils.encodeUint64LE(uint64(params.amount)),
            Utils.encodeUint64LE(_computeNonce(params)),
            Utils.encodeUint64LE(uint64(params.expiration))
        );

        if (params.data.length == 0) {
            return bytes.concat(TRANSFER_REQUEST_PREFIX, payload);
        }

        SolanaRoutedWithdrawalData memory routed = _decodeRoutedWithdrawalData(
            params.destinationChainId, params.depository, params.data
        );
        // GatewayRoutedTransferRequest is the plain request with `router` appended, under its own type prefix
        return bytes.concat(ROUTED_TRANSFER_REQUEST_PREFIX, payload, routed.router);
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    /// @dev The request commits to the depository program through its domain separator
    function hashExecutionPayload(string calldata, bytes calldata, bytes calldata payload)
        external
        pure
        returns (bytes32 digest)
    {
        return sha256(payload);
    }

    /// @notice Returns the config key used to look up the Gateway depository program's domain separator
    /// @param chainId Relay destination chain id
    /// @return key Config key
    function getDomainKey(string memory chainId) public pure returns (bytes32 key) {
        return keccak256(abi.encodePacked(GATEWAY_SOLANA_VM_DOMAIN_PREFIX, keccak256(bytes(chainId))));
    }

    /// @notice Returns the standard solana-vm expiration-delay key
    /// @return key Config key
    function getExpirationKey() public pure returns (bytes32 key) {
        return SOLANA_VM_EXPIRATION_KEY;
    }

    /// @notice Returns the config key allowlisting a router for a chain and depository
    /// @param chainId Relay destination chain id
    /// @param depository Configured Gateway destination depository, the program's vault token account
    /// @param router Router program id
    /// @return key Config key
    function getRouterAllowedKey(string memory chainId, bytes32 depository, bytes32 router)
        public
        pure
        returns (bytes32 key)
    {
        return keccak256(
            abi.encode(SOLANA_VM_ROUTER_ALLOWED_PREFIX, keccak256(bytes(chainId)), depository, router)
        );
    }

    /// @notice Computes the request nonce from the block, the builder identity, and the request
    /// @param params VM-neutral execution parameters
    /// @return nonce Derived request nonce truncated to uint64 for Solana payloads
    function _computeNonce(GatewayExecutionParams calldata params) private view returns (uint64 nonce) {
        return uint64(uint256(keccak256(abi.encode(block.number, address(this), params))));
    }

    /// @notice Decodes routed withdrawal data and enforces the routed-mode constraints
    /// @param chainId Relay destination chain id
    /// @param depository Encoded destination depository
    /// @param data Encoded routed withdrawal data
    /// @return routed Decoded routed withdrawal data
    function _decodeRoutedWithdrawalData(string calldata chainId, bytes calldata depository, bytes calldata data)
        private
        view
        returns (SolanaRoutedWithdrawalData memory routed)
    {
        if (depository.length != 32) {
            revert InvalidAddressLength(depository.length, 32);
        }

        routed = abi.decode(data, (SolanaRoutedWithdrawalData));
        if (routed.version != ROUTED_WITHDRAWAL_DATA_VERSION) {
            revert UnsupportedRoutedDataVersion(routed.version);
        }

        bytes32 allowedValue =
            CONFIG.getConfigValue(getRouterAllowedKey(chainId, bytes32(depository), routed.router));
        if (allowedValue != bytes32(uint256(1))) {
            revert RouterNotAllowed(routed.router);
        }
    }
}
