// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PayloadBuilder} from "../Allocator.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

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

contract EVMPayloadBuilder is PayloadBuilder {
  // Implement the logic to build the payload for EVM chains
  // This must return a "  CallRequest calldata request" as defined in https://github.com/relayprotocol/escrow-contracts/blob/main/packages/ethereum-vm/src/utils/RelayEscrowStructs.sol

  function buildPayload(
    uint256 /* chainId */,
    address /* escrow */,
    address currency,
    uint256 amount,
    string memory receiver,
    bytes calldata /* data */
  ) external view override returns (bytes memory) {
    CallRequest memory request = CallRequest({
      calls: new Call[](1), //  What size?
      nonce: uint256(keccak256(abi.encodePacked(block.timestamp))),
      expiration: block.timestamp + 10 days // Can we get the delay from the Allocator?
    });

    if (currency == address(0)) {
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
        to: currency,
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

  function hashPayload(
    uint256 /* chainId */,
    address /* escrow */,
    bytes calldata payload
  ) external pure returns (bytes32) {
    return
      keccak256(
        abi.encodePacked(
          "\x19Ethereum Signed Message:\n",
          Strings.toString(payload.length),
          payload
        )
      );
  }

  // Converts a string representation of an address to an address type
  function toAddress(string memory s) internal pure returns (address) {
    bytes memory b = bytes(s);
    require(b.length == 42, "Invalid address length");

    uint160 result = 0;
    for (uint i = 2; i < 42; i++) {
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
