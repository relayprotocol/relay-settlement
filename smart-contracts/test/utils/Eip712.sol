// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Helpers for producing EIP-712 signatures in Foundry tests, mirroring
/// the `signTypedData` flows used by the TS test suite.
library Eip712 {
    Vm internal constant VM =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    /// @notice Computes the EIP-712 domain separator for the given parameters.
    /// Matches OpenZeppelin's EIP712 contract output when name + version are
    /// passed to its constructor (chainId/verifyingContract resolved at call
    /// time).
    function domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    chainId,
                    verifyingContract
                )
            );
    }

    /// @notice Computes the typed-data digest from a domain separator and a
    /// pre-hashed struct, then signs it with the given private key.
    function sign(
        uint256 privateKey,
        bytes32 separator,
        bytes32 structHash
    ) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", separator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
