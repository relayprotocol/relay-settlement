// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// The only TransferSpec version supported by Circle Gateway v1
uint32 constant CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION = 1;

/// @notice Circle Gateway's description of a cross-domain USDC transfer
/// @dev Field order and types must remain byte-for-byte compatible with Circle Gateway
struct TransferSpec {
    uint32 version;
    uint32 sourceDomain;
    uint32 destinationDomain;
    bytes32 sourceContract;
    bytes32 destinationContract;
    bytes32 sourceToken;
    bytes32 destinationToken;
    bytes32 sourceDepositor;
    bytes32 destinationRecipient;
    bytes32 sourceSigner;
    bytes32 destinationCaller;
    uint256 value;
    bytes32 salt;
    bytes hookData;
}

/// @notice A request authorizing Circle Gateway to debit one source domain
struct BurnIntent {
    uint256 maxBlockHeight;
    uint256 maxFee;
    TransferSpec spec;
}
