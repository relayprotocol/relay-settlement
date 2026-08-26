// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BurnIntent, TransferSpec} from "./CircleGatewayTypes.sol";

/// @title CircleGatewayCodec
/// @author Relay Protocol
/// @notice Encodes and hashes Circle Gateway transfer specs and burn intents
/// @dev Matches Circle Gateway's v1 packed wire format and chain-independent EIP-712 domain
library CircleGatewayCodec {
    error HookDataTooLong(uint256 length);
    error TransferSpecTooLong(uint256 length);

    bytes4 internal constant TRANSFER_SPEC_MAGIC = 0xca85def7;
    bytes4 internal constant BURN_INTENT_MAGIC = 0x070afbc2;

    bytes32 internal constant TRANSFER_SPEC_TYPEHASH =
        0x44409c7ba8872720f5fc290d2788c2d70a3905b7ca1cdb2ffa152791a69e089b;
    bytes32 internal constant BURN_INTENT_TYPEHASH = 0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c;

    /// @dev Circle intentionally omits chainId and verifyingContract from this domain
    bytes32 internal constant GATEWAY_WALLET_DOMAIN_SEPARATOR =
        0x23a37920eca61226c76d13c4462857a362147e4b18da665dba894fa297ae4f34;

    /// @notice Left-pads an EVM address into Circle Gateway's bytes32 address representation
    /// @return The address encoded as a bytes32 value
    function addressToBytes32(address value) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }

    /// @notice Encodes a TransferSpec using Circle Gateway's packed wire format
    /// @return The packed TransferSpec bytes accepted by Circle Gateway
    function encodeTransferSpec(TransferSpec memory spec) internal pure returns (bytes memory) {
        if (spec.hookData.length > type(uint32).max) {
            revert HookDataTooLong(spec.hookData.length);
        }

        bytes memory header = abi.encodePacked(
            TRANSFER_SPEC_MAGIC,
            spec.version,
            spec.sourceDomain,
            spec.destinationDomain,
            spec.sourceContract,
            spec.destinationContract,
            spec.sourceToken,
            spec.destinationToken,
            spec.sourceDepositor
        );
        bytes memory footer = abi.encodePacked(
            spec.destinationRecipient,
            spec.sourceSigner,
            spec.destinationCaller,
            spec.value,
            spec.salt,
            uint32(spec.hookData.length),
            spec.hookData
        );

        return bytes.concat(header, footer);
    }

    /// @notice Returns Circle's cross-chain transfer identifier and replay-protection key
    /// @return The keccak256 hash of the packed TransferSpec
    function hashTransferSpec(TransferSpec memory spec) internal pure returns (bytes32) {
        return keccak256(encodeTransferSpec(spec));
    }

    /// @notice Returns the EIP-712 struct hash of a TransferSpec
    /// @return The TransferSpec EIP-712 struct hash
    function hashTransferSpecTypedData(TransferSpec memory spec) internal pure returns (bytes32) {
        bytes memory header = abi.encode(
            TRANSFER_SPEC_TYPEHASH,
            spec.version,
            spec.sourceDomain,
            spec.destinationDomain,
            spec.sourceContract,
            spec.destinationContract,
            spec.sourceToken,
            spec.destinationToken
        );
        bytes memory footer = abi.encode(
            spec.sourceDepositor,
            spec.destinationRecipient,
            spec.sourceSigner,
            spec.destinationCaller,
            spec.value,
            spec.salt,
            keccak256(spec.hookData)
        );

        return keccak256(bytes.concat(header, footer));
    }

    /// @notice Encodes a BurnIntent using Circle Gateway's packed wire format
    /// @return The packed BurnIntent bytes accepted by Circle Gateway
    function encodeBurnIntent(BurnIntent memory intent) internal pure returns (bytes memory) {
        bytes memory encodedSpec = encodeTransferSpec(intent.spec);
        if (encodedSpec.length > type(uint32).max) {
            revert TransferSpecTooLong(encodedSpec.length);
        }

        return abi.encodePacked(
            BURN_INTENT_MAGIC, intent.maxBlockHeight, intent.maxFee, uint32(encodedSpec.length), encodedSpec
        );
    }

    /// @notice Returns the EIP-712 struct hash of a BurnIntent
    /// @return The BurnIntent EIP-712 struct hash
    function hashBurnIntentTypedData(BurnIntent memory intent) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BURN_INTENT_TYPEHASH, intent.maxBlockHeight, intent.maxFee, hashTransferSpecTypedData(intent.spec)
            )
        );
    }

    /// @notice Returns the digest signed by a Circle GatewayWallet source signer
    /// @return The chain-independent EIP-712 digest for the BurnIntent
    function hashBurnIntent(BurnIntent memory intent) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", GATEWAY_WALLET_DOMAIN_SEPARATOR, hashBurnIntentTypedData(intent)));
    }
}
