// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Config} from "../../Config.sol";
import {Utils} from "../../Utils.sol";
import {GatewayExecutionParams, IGatewayDestinationPayloadBuilder} from "./IGatewayDestinationPayloadBuilder.sol";

/// @notice Individual call within a Gateway execution request
/// @dev A call carries either its calldata or a commitment to it, and both forms hash to the
/// same EIP-712 digest, so the executor can supply the calldata a committed call omits
struct Call {
    address to;
    bytes data;
    bytes32 dataHash;
    uint256 value;
    bool allowFailure;
}

/// @notice EVM execution request authorized by Relay's Gateway signer
struct CallRequest {
    bytes32 transferSpecHash;
    Call[] calls;
    uint256 nonce;
    uint256 expiration;
}

/// @notice Versioned routed withdrawal data for an EVM Gateway destination
/// @param version Routed data version, must equal ROUTED_WITHDRAWAL_DATA_VERSION
/// @param router Allowlisted router executing the committed calldata
/// @param dataHash Commitment to the calldata of the router call
struct RoutedWithdrawalData {
    uint8 version;
    address router;
    bytes32 dataHash;
}

/// @title GatewayEthereumVmDestinationPayloadBuilder
/// @author Relay Protocol
/// @notice Builds and hashes Gateway execution requests for EVM destinations
contract GatewayEthereumVmDestinationPayloadBuilder is IGatewayDestinationPayloadBuilder {
    error InvalidReceiverLength(uint256 length);
    error InvalidDepositoryLength(uint256 length);
    error UnsupportedRoutedDataVersion(uint8 version);
    error EmptyRoutedCallsHash();
    error RouterNotAllowed(address router);

    /// @notice Thrown when a call supplies both its calldata and a commitment to it
    error AmbiguousCallData();

    /// @notice Circle GatewayWallet shared by supported EVM chains
    bytes32 public constant GATEWAY_WALLET = 0x00000000000000000000000077777777dcc4d5a8b6e418fd04d8997ef11000ee;
    /// @notice Circle GatewayMinter shared by supported EVM chains
    bytes32 public constant GATEWAY_MINTER = 0x0000000000000000000000002222222d7164433c4c09b0b0d809a9b52c04c205;

    /// @notice Config contract containing Gateway and standard ethereum-vm metadata
    Config public immutable CONFIG;

    /// @notice EIP-712 signing domain used by the Gateway EVM depository
    string public constant SIGNING_DOMAIN = "RelayGatewayDepository";
    /// @notice EIP-712 signing version used by the Gateway EVM depository
    string public constant SIGNATURE_VERSION = "1";
    /// @notice EIP-712 typehash for Call
    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");
    /// @notice EIP-712 typehash for CallRequest
    bytes32 public constant CALL_REQUEST_TYPEHASH = keccak256(
        "CallRequest(bytes32 transferSpecHash,Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

    bytes32 internal constant ETHEREUM_VM_CHAIN_ID_PREFIX = keccak256("ETHEREUM_VM_CHAIN_ID");
    bytes32 internal constant ETHEREUM_VM_EXPIRATION_KEY = keccak256("ETHEREUM_VM_EXPIRATION");
    bytes32 internal constant ETHEREUM_VM_ROUTER_ALLOWED_PREFIX = keccak256("ETHEREUM_VM_ROUTER_ALLOWED");
    bytes32 internal constant EMPTY_CALLDATA_HASH = keccak256("");

    /// @notice Supported routed withdrawal data version
    uint8 public constant ROUTED_WITHDRAWAL_DATA_VERSION = 1;

    /// @notice Creates an EVM destination payload builder
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
    function buildExecutionPayload(GatewayExecutionParams calldata params)
        external
        view
        returns (bytes memory payload)
    {
        if (params.receiver.length != 20) {
            revert InvalidReceiverLength(params.receiver.length);
        }

        Call[] memory calls = new Call[](params.data.length == 0 ? 1 : 2);
        calls[0] = Call({
            to: address(uint160(uint256(params.destinationToken))),
            data: abi.encodeWithSignature(
                "transfer(address,uint256)", address(bytes20(params.receiver)), params.amount
            ),
            dataHash: bytes32(0),
            value: 0,
            allowFailure: false
        });

        if (params.data.length != 0) {
            RoutedWithdrawalData memory routed = _decodeRoutedWithdrawalData(
                params.destinationChainId, params.depository, params.data
            );
            calls[1] = Call({
                to: routed.router,
                data: "",
                dataHash: routed.dataHash,
                value: 0,
                allowFailure: false
            });
        }

        return abi.encode(
            CallRequest({
                transferSpecHash: params.transferSpecHash,
                calls: calls,
                nonce: _computeNonce(params),
                expiration: params.expiration
            })
        );
    }

    /// @notice Computes the execution-request nonce from the block, the builder identity, and the request
    /// @dev Commits to `address(this)` and every field of `params` — which carries the destination chain id
    /// and the depository — so a nonce built for one builder, chain, or depository can never be reused for
    /// another. `block.number` leads the preimage so a rebuild of the same request in a later block yields
    /// a fresh nonce.
    /// @param params VM-neutral execution parameters
    /// @return nonce Derived execution-request nonce
    function _computeNonce(GatewayExecutionParams calldata params) private view returns (uint256 nonce) {
        return uint256(keccak256(abi.encode(block.number, address(this), params)));
    }

    /// @inheritdoc IGatewayDestinationPayloadBuilder
    /// @dev A committed call substitutes its `dataHash` for `keccak256(data)`, so the digest
    /// equals the one the depository derives from the same call with its calldata supplied
    function hashExecutionPayload(string calldata destinationChainId, bytes calldata depository, bytes calldata payload)
        external
        view
        returns (bytes32 digest)
    {
        uint256 evmChainId = uint256(CONFIG.getConfigValue(getEvmChainIdKey(destinationChainId)));
        bytes32 domainSeparator =
            Utils.buildDomainSeparator(SIGNING_DOMAIN, SIGNATURE_VERSION, evmChainId, _depositoryAddress(depository));
        CallRequest memory request = abi.decode(payload, (CallRequest));
        bytes32[] memory callHashes = new bytes32[](request.calls.length);
        for (uint256 i = 0; i < request.calls.length; ++i) {
            bytes32 dataHash = request.calls[i].dataHash;
            if (dataHash == bytes32(0)) {
                dataHash = keccak256(request.calls[i].data);
            } else if (request.calls[i].data.length != 0) {
                revert AmbiguousCallData();
            }

            callHashes[i] = keccak256(
                abi.encode(
                    CALL_TYPEHASH,
                    request.calls[i].to,
                    dataHash,
                    request.calls[i].value,
                    request.calls[i].allowFailure
                )
            );
        }
        bytes32 structHash = keccak256(
            abi.encode(
                CALL_REQUEST_TYPEHASH,
                request.transferSpecHash,
                keccak256(abi.encodePacked(callHashes)),
                request.nonce,
                request.expiration
            )
        );

        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @notice Returns the standard ethereum-vm chain-id key for a Relay chain id
    /// @param chainId Relay chain id
    /// @return The EVM chain-id config key
    function getEvmChainIdKey(string memory chainId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(ETHEREUM_VM_CHAIN_ID_PREFIX, chainId));
    }

    /// @notice Returns the standard ethereum-vm expiration-delay key
    /// @return The expiration config key
    function getExpirationKey() public pure returns (bytes32) {
        return ETHEREUM_VM_EXPIRATION_KEY;
    }

    /// @notice Returns the config key allowlisting a router for a chain and depository
    /// @param chainId Relay destination chain id
    /// @param depository Depository address on the destination chain
    /// @param router Router address on the destination chain
    /// @return key Config key
    function getRouterAllowedKey(string memory chainId, address depository, address router)
        public
        pure
        returns (bytes32 key)
    {
        return keccak256(
            abi.encode(ETHEREUM_VM_ROUTER_ALLOWED_PREFIX, keccak256(bytes(chainId)), depository, router)
        );
    }

    /// @notice Decodes routed data and validates its commitment and router
    /// @param chainId Relay destination chain id
    /// @param depository Encoded destination depository
    /// @param data Encoded routed withdrawal data
    /// @return routed Decoded routed withdrawal data
    function _decodeRoutedWithdrawalData(string calldata chainId, bytes calldata depository, bytes calldata data)
        private
        view
        returns (RoutedWithdrawalData memory routed)
    {
        if (depository.length != 20 && depository.length != 32) {
            revert InvalidDepositoryLength(depository.length);
        }

        routed = abi.decode(data, (RoutedWithdrawalData));
        if (routed.version != ROUTED_WITHDRAWAL_DATA_VERSION) {
            revert UnsupportedRoutedDataVersion(routed.version);
        }
        if (routed.dataHash == bytes32(0) || routed.dataHash == EMPTY_CALLDATA_HASH) {
            revert EmptyRoutedCallsHash();
        }

        bytes32 allowedValue =
            CONFIG.getConfigValue(getRouterAllowedKey(chainId, _depositoryAddress(depository), routed.router));
        if (allowedValue != bytes32(uint256(1))) {
            revert RouterNotAllowed(routed.router);
        }
    }

    /// @notice Decodes either raw 20-byte EVM depository bytes or Circle-encoded bytes32
    /// @param depository Raw or Circle-encoded EVM depository
    /// @return decoded Depository address
    function _depositoryAddress(bytes calldata depository) private pure returns (address decoded) {
        if (depository.length == 32) {
            return address(uint160(uint256(bytes32(depository))));
        }

        return address(bytes20(depository));
    }
}
