// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice VM-neutral inputs used to build a destination execution payload
struct GatewayExecutionParams {
    string destinationChainId;
    bytes32 transferSpecHash;
    bytes32 destinationToken;
    bytes depository;
    bytes receiver;
    uint256 amount;
    uint256 nonce;
    uint256 expiration;
    bytes data;
}

/// @title IGatewayDestinationPayloadBuilder
/// @author Relay Protocol
/// @notice Adapts a Gateway withdrawal to a destination VM's execution and signing format
interface IGatewayDestinationPayloadBuilder {
    /// @notice Returns the Circle source contract used by this destination family
    /// @return contractAddress Circle source contract encoded as bytes32
    function sourceContract() external view returns (bytes32 contractAddress);

    /// @notice Returns the Circle destination contract used by this destination family
    /// @return contractAddress Circle destination contract encoded as bytes32
    function destinationContract() external view returns (bytes32 contractAddress);

    /// @notice Returns the configured execution expiration delay for this destination family
    /// @return delay Execution expiration delay in seconds
    function getExpirationDelay() external view returns (uint256 delay);

    /// @notice Builds the VM-specific execution payload
    /// @param params VM-neutral execution parameters
    /// @return payload Encoded execution payload
    function buildExecutionPayload(GatewayExecutionParams calldata params) external view returns (bytes memory payload);

    /// @notice Returns the digest authorizing a VM-specific execution payload
    /// @param destinationChainId Relay destination chain id
    /// @param depository VM-specific encoded destination depository
    /// @param payload Encoded execution payload
    /// @return digest Execution authorization digest
    function hashExecutionPayload(string calldata destinationChainId, bytes calldata depository, bytes calldata payload)
        external
        view
        returns (bytes32 digest);
}
