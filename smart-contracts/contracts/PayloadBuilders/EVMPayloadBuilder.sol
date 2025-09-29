// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPayloadBuilder} from "../Allocator.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Utils} from "../Utils.sol";

// Taken from https://github.com/relayprotocol/depository-contracts/blob/main/packages/ethereum-vm/src/utils/RelayDepositoryStructs.sol
/// @notice Individual call within a batch request
struct Call {
  address to; /// @notice Target contract address
  bytes data; /// @notice Call data
  uint256 value; /// @notice ETH value to send
  bool allowFailure; /// @notice Whether call can fail without reverting batch
}

/// @notice Batch call request for depository
struct CallRequest {
  Call[] calls; /// @notice Array of calls to execute
  uint256 nonce; /// @notice Request nonce for replay protection
  uint256 expiration; /// @notice Request expiration timestamp
}

/// @notice Current depository information
struct CurrentDepository {
  address depository; /// @notice Depository contract address
  uint256 chainId; /// @notice Chain ID where depository is deployed
}

/// @title EVMPayloadBuilder
/// @author Relay Protocol
/// @notice Builds EIP-712 compliant payloads for EVM chain withdrawals
contract EVMPayloadBuilder is IPayloadBuilder {
  // EIP712 domain configuration
  /// @notice The signing domain for EIP712
  string public constant SIGNING_DOMAIN = "RelayDepository";
  /// @notice The signature version for EIP712
  string public constant SIGNATURE_VERSION = "1";

  /// @notice EIP-712 typehash for Call struct
  bytes32 public constant CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");

  /// @notice EIP-712 typehash for CallRequest struct
  bytes32 public constant CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

  /// @notice Builds EIP-712 compliant CallRequest for EVM withdrawal
  /// @param currency Token address (zero for native ETH)
  /// @param amount Amount to withdraw
  /// @param receiver Recipient address
  /// @return Encoded CallRequest struct
  function buildPayload(
    uint256 /* chainId */,
    string calldata /* depository */,
    string calldata currency,
    uint256 amount,
    string memory receiver,
    bytes calldata /* data */
  ) external view override returns (bytes memory) {
    CallRequest memory request = CallRequest({
      calls: new Call[](1), //  What size?
      nonce: uint256(keccak256(abi.encodePacked(block.timestamp))),
      expiration: block.timestamp + 10 days // Can we get the delay from the Allocator?
    });
    address currencyAddress = Utils.toAddress(currency);

    if (currencyAddress == address(0)) {
      // If this is a native transfer, we need to set the value to the amount
      // and the data to an empty bytes array
      request.calls[0] = Call({
        to: Utils.toAddress(receiver),
        data: bytes(""),
        value: amount,
        allowFailure: false
      });
    } else {
      // Otherwise we assume this is an ERC20 transfer
      request.calls[0] = Call({
        to: currencyAddress,
        data: abi.encodeWithSignature(
          "transfer(address,uint256)",
          Utils.toAddress(receiver),
          amount
        ),
        value: 0,
        allowFailure: false
      });
    }

    return abi.encode(request);
  }

  /// @notice Returns EIP-712 hash to sign for CallRequest
  /// @param chainId Target chain ID
  /// @param depository Depository contract address
  /// @param payload Encoded CallRequest
  /// @return Array with single EIP-712 hash
  function hashToSign(
    uint256 chainId,
    string calldata depository,
    bytes calldata payload,
    uint32 /* hashIndex */
  ) external pure returns (bytes32) {
    CallRequest memory request = abi.decode(payload, (CallRequest));
    bytes32 domainSeparator = buildDomainSeparator(chainId, depository);
    (, bytes32 eip712Hash) = hashCallRequest(request, domainSeparator);
    return eip712Hash;
  }

  /// @notice Builds EIP-712 domain separator for depository
  /// @param chainId Target chain ID
  /// @param depository Depository contract address
  /// @return EIP-712 domain separator
  function buildDomainSeparator(
    uint256 chainId,
    string calldata depository
  ) internal pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
          ),
          keccak256(bytes(SIGNING_DOMAIN)),
          keccak256(bytes(SIGNATURE_VERSION)),
          chainId,
          Utils.toAddress(depository)
        )
      );
  }

  /// @notice Hashes CallRequest and returns EIP-712 digest
  /// @param request CallRequest to hash
  /// @param domainSeparator EIP-712 domain separator
  /// @return structHash Struct hash
  /// @return eip712Hash Complete EIP-712 hash
  function hashCallRequest(
    CallRequest memory request,
    bytes32 domainSeparator
  ) internal pure returns (bytes32 structHash, bytes32 eip712Hash) {
    // Initialize the array of call hashes
    bytes32[] memory callHashes = new bytes32[](request.calls.length);

    // Iterate over the underlying calls
    for (uint256 i = 0; i < request.calls.length; i++) {
      // Hash the call
      bytes32 callHash = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          request.calls[i].to,
          keccak256(request.calls[i].data),
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );

      // Store the hash in the array
      callHashes[i] = callHash;
    }

    // Get the struct hash
    structHash = keccak256(
      abi.encode(
        CALL_REQUEST_TYPEHASH,
        keccak256(abi.encodePacked(callHashes)),
        request.nonce, // Q: why no expiration here?
        request.expiration
      )
    );

    // Get the EIP-712 hash
    eip712Hash = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
  }

  /// @notice Returns cryptographic curve for EVM signing
  /// @return curve "Ecdsa" for EVM chains
  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  /// @notice Returns blockchain family identifier
  /// @return family "ethereum-vm" for EVM chains
  function family() external pure returns (string memory) {
    return "ethereum-vm";
  }
}
