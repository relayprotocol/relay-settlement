// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice The executable call the depository consumes: no commitment column
struct DepositoryCall {
  address to;
  bytes data;
  uint256 value;
  bool allowFailure;
}

/// @notice The executable request the depository consumes
struct DepositoryCallRequest {
  DepositoryCall[] calls;
  uint256 nonce;
  uint256 expiration;
}

/// @notice Verbatim copy of `RelayDepository._hashCallRequest`, which lives in a separate
/// Foundry project, so builder digests can be asserted against it rather than against
/// the builder's own hashing
library DepositoryHashRef {
  bytes32 internal constant CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");

  bytes32 internal constant CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

  /// @notice Hashes an executable CallRequest the way the depository does
  /// @param request Executable request, with every call's real calldata supplied
  /// @param domainSeparator EIP-712 domain separator
  /// @return eip712Hash EIP-712 hash
  function hash(
    DepositoryCallRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32 eip712Hash) {
    bytes32[] memory callHashes = new bytes32[](request.calls.length);

    for (uint256 i = 0; i < request.calls.length; i++) {
      callHashes[i] = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          request.calls[i].to,
          keccak256(request.calls[i].data),
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );
    }

    bytes32 structHash = keccak256(
      abi.encode(
        CALL_REQUEST_TYPEHASH,
        keccak256(abi.encodePacked(callHashes)),
        request.nonce,
        request.expiration
      )
    );

    eip712Hash = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }
}
