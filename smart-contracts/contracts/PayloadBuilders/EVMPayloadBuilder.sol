// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EIP712, MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// Taken from https://github.com/relayprotocol/escrow-contracts/blob/main/packages/ethereum-vm/src/utils/RelayEscrowStructs.sol
struct Call {
  address to;
  bytes data;
  uint256 value;
  bool allowFailure;
}
struct CallRequest {
  Call[] calls;
  uint256 nonce;
  uint256 expiration;
}
struct CurrentEscrow {
  address escrow;
  uint256 chainId;
}

// Implement the logic to build the payload for EVM chains
contract EVMPayloadBuilder is PayloadBuilder {
  // EIP712 domain and version
  string public constant SIGNING_DOMAIN = "RelayEscrow";
  string public constant SIGNATURE_VERSION = "1";

  /// @notice The EIP-712 typehash for the Call struct
  bytes32 public constant CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");

  /// @notice The EIP-712 typehash for the CallRequest struct
  bytes32 public constant CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );

  constructor() {}

  // This must return a "CallRequest calldata request"
  // as defined in https://github.com/relayprotocol/escrow-contracts/blob/main/packages/ethereum-vm/src/utils/RelayEscrowStructs.sol
  function buildPayload(
    uint256 /* chainId */,
    address /* escrow */,
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
    address currencyAddress = toAddress(currency);

    if (currencyAddress == address(0)) {
      // If this is a native transfer, we need to set the value to the amount
      // and the data to an empty bytes array
      request.calls[0] = Call({
        to: toAddress(receiver),
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
          toAddress(receiver),
          amount
        ),
        value: 0,
        allowFailure: false
      });
    }

    return abi.encode(request);
  }

  /// @notice Hashes a payload using EIP-712 standard
  /// @param payload The encoded CallRequest payload to hash
  /// @return The EIP-712 hash of the payload
  function hashPayload(
    uint256 chainId,
    address escrow,
    bytes calldata payload
  ) external pure returns (bytes32) {
    // decode the payload
    CallRequest memory request = abi.decode(payload, (CallRequest));
    bytes32 domainSeparator = buildDomainSeparator(chainId, escrow);
    (, bytes32 eip712Hash) = hashCallRequest(request, domainSeparator);
    return eip712Hash;
  }

  /// @notice Returns an EIP-712 domain separator for the escrow
  /// @return The EIP-712 domain separator
  function buildDomainSeparator(
    uint256 chainId,
    address escrow
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
          escrow
        )
      );
  }

  /// @notice Helper function to hash a CallRequest and return the EIP-712 digest
  /// @param request The CallRequest to hash
  /// @return structHash The struct hash
  /// @return eip712Hash The EIP712 hash
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

  function curve() external pure returns (string memory) {
    return "Ecdsa";
  }

  // Converts a string representation of an address to an address type
  function toAddress(string memory s) public pure returns (address) {
    bytes memory b = bytes(s);
    require(b.length == 42, "Invalid address length");

    uint160 result = 0;
    for (uint256 i = 2; i < 42; i++) {
      result <<= 4;
      uint8 c = uint8(b[i]);

      if (c >= 48 && c <= 57) {
        result |= uint160(c - 48); // 0-9
      } else if (c >= 65 && c <= 70) {
        result |= uint160(c - 55); // A-F
      } else if (c >= 97 && c <= 102) {
        result |= uint160(c - 87); // a-f
      } else {
        revert("Invalid character in address");
      }
    }
    return address(result);
  }
}
