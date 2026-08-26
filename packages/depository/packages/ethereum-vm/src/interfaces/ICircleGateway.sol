// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title ICircleGatewayWallet
/// @author Relay Protocol
/// @notice Circle GatewayWallet methods used by RelayGatewayDepository
interface ICircleGatewayWallet {
  /// @notice Deposits tokens into another address's unified Gateway balance
  function depositFor(address token, address depositor, uint256 value) external;
}

/// @title ICircleGatewayMinter
/// @author Relay Protocol
/// @notice Circle GatewayMinter methods used by RelayGatewayDepository
interface ICircleGatewayMinter {
  /// @notice Mints tokens from a Circle-signed Gateway attestation
  function gatewayMint(
    bytes memory attestationPayload,
    bytes memory signature
  ) external;

  /// @notice Returns whether a Circle transfer-spec hash has been consumed
  /// @return used True when the transfer-spec hash has been consumed
  function isTransferSpecHashUsed(
    bytes32 transferSpecHash
  ) external view returns (bool used);
}
