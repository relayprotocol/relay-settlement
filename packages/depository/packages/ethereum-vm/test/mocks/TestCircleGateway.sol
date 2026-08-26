// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {
  ICircleGatewayMinter,
  ICircleGatewayWallet
} from "../../src/interfaces/ICircleGateway.sol";
import {TestERC20} from "./TestERC20.sol";

contract TestCircleGatewayWallet is ICircleGatewayWallet {
  using SafeTransferLib for address;

  mapping(address token => mapping(address depositor => uint256 amount))
    public balances;

  function depositFor(
    address token,
    address depositor,
    uint256 value
  ) external {
    token.safeTransferFrom(msg.sender, address(this), value);
    balances[token][depositor] += value;
  }
}

contract TestCircleGatewayMinter is ICircleGatewayMinter {
  error InvalidAttestationEncoding();

  bytes4 internal constant ATTESTATION_MAGIC = 0xff6fb334;
  bytes4 internal constant ATTESTATION_SET_MAGIC = 0x1e12db71;
  uint256 internal constant ATTESTATION_HEADER_LENGTH = 40;
  uint256 internal constant ATTESTATION_SET_HEADER_LENGTH = 8;
  uint256 internal constant TRANSFER_SPEC_DESTINATION_RECIPIENT_OFFSET = 176;
  uint256 internal constant TRANSFER_SPEC_VALUE_OFFSET = 272;
  uint256 internal constant TRANSFER_SPEC_MINIMUM_LENGTH = 340;

  TestERC20 public immutable USDC;

  mapping(bytes32 transferSpecHash => bool used) public usedTransferSpecHashes;
  uint256 public mintCallCount;

  constructor(address usdc) {
    USDC = TestERC20(usdc);
  }

  function gatewayMint(bytes memory attestationPayload, bytes memory) external {
    mintCallCount++;

    bytes4 magic = _readBytes4(attestationPayload, 0);
    if (magic == ATTESTATION_MAGIC) {
      uint256 end = _mintAttestation(attestationPayload, 0);
      if (end != attestationPayload.length) {
        revert InvalidAttestationEncoding();
      }
      return;
    }
    if (magic != ATTESTATION_SET_MAGIC) {
      revert InvalidAttestationEncoding();
    }

    uint32 count = _readUint32(attestationPayload, 4);
    uint256 offset = ATTESTATION_SET_HEADER_LENGTH;
    for (uint32 i = 0; i < count; i++) {
      offset = _mintAttestation(attestationPayload, offset);
    }
    if (offset != attestationPayload.length) {
      revert InvalidAttestationEncoding();
    }
  }

  function _mintAttestation(
    bytes memory payload,
    uint256 attestationOffset
  ) private returns (uint256 end) {
    if (_readBytes4(payload, attestationOffset) != ATTESTATION_MAGIC) {
      revert InvalidAttestationEncoding();
    }

    uint32 transferSpecLength = _readUint32(payload, attestationOffset + 36);
    if (transferSpecLength < TRANSFER_SPEC_MINIMUM_LENGTH) {
      revert InvalidAttestationEncoding();
    }

    uint256 transferSpecOffset = attestationOffset + ATTESTATION_HEADER_LENGTH;
    end = transferSpecOffset + uint256(transferSpecLength);
    if (end > payload.length) {
      revert InvalidAttestationEncoding();
    }

    bytes32 transferSpecHash = _hash(
      payload,
      transferSpecOffset,
      transferSpecLength
    );
    bytes32 recipient = _readBytes32(
      payload,
      transferSpecOffset + TRANSFER_SPEC_DESTINATION_RECIPIENT_OFFSET
    );
    uint256 amount = _readUint256(
      payload,
      transferSpecOffset + TRANSFER_SPEC_VALUE_OFFSET
    );

    usedTransferSpecHashes[transferSpecHash] = true;
    USDC.mint(address(uint160(uint256(recipient))), amount);
  }

  function _readBytes4(
    bytes memory data,
    uint256 offset
  ) private pure returns (bytes4 value) {
    if (data.length < offset + 4) {
      revert InvalidAttestationEncoding();
    }
    assembly {
      value := mload(add(add(data, 0x20), offset))
    }
  }

  function _readUint32(
    bytes memory data,
    uint256 offset
  ) private pure returns (uint32 value) {
    if (data.length < offset + 4) {
      revert InvalidAttestationEncoding();
    }
    assembly {
      value := shr(224, mload(add(add(data, 0x20), offset)))
    }
  }

  function _readBytes32(
    bytes memory data,
    uint256 offset
  ) private pure returns (bytes32 value) {
    if (data.length < offset + 32) {
      revert InvalidAttestationEncoding();
    }
    assembly {
      value := mload(add(add(data, 0x20), offset))
    }
  }

  function _readUint256(
    bytes memory data,
    uint256 offset
  ) private pure returns (uint256 value) {
    if (data.length < offset + 32) {
      revert InvalidAttestationEncoding();
    }
    assembly {
      value := mload(add(add(data, 0x20), offset))
    }
  }

  function _hash(
    bytes memory data,
    uint256 offset,
    uint256 length
  ) private pure returns (bytes32 value) {
    if (data.length < offset + length) {
      revert InvalidAttestationEncoding();
    }
    assembly {
      value := keccak256(add(add(data, 0x20), offset), length)
    }
  }

  function isTransferSpecHashUsed(
    bytes32 transferSpecHash
  ) external view returns (bool) {
    return usedTransferSpecHashes[transferSpecHash];
  }

  function setTransferSpecHashUsed(bytes32 transferSpecHash) external {
    usedTransferSpecHashes[transferSpecHash] = true;
  }
}
