// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleMultisigBase} from "./RelayOracleMultisigBase.sol";
import {RelayOracleMultisig} from "../../contracts/RelayOracleMultisig.sol";

/// @notice Port of test/RelayOracleMultisig/isValidSignature.ts.
contract RelayOracleMultisigIsValidSignatureTest is RelayOracleMultisigBase {
    RelayOracleMultisig internal multisig;

    function setUp() public override {
        super.setUp();
        multisig = _defaultMultisig();
    }

    // signMessage with `{ raw }` applies the eth_sign prefix.
    function _hashMessage(bytes32 raw) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19Ethereum Signed Message:\n32", raw)
            );
    }

    function _signEthMsg(
        uint256 pk,
        bytes32 raw
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _hashMessage(raw));
        return abi.encodePacked(r, s, v);
    }

    function _combine(
        uint256[2] memory pks,
        bytes32 raw
    ) internal pure returns (bytes memory) {
        bytes memory sig0 = _signEthMsg(pks[0], raw);
        bytes memory sig1 = _signEthMsg(pks[1], raw);
        return bytes.concat(sig0, sig1);
    }

    function test_returnsMagicValueForValidThresholdSignatures() public view {
        bytes32 message = keccak256("msg-1");
        // Signers are already sorted ascending (smallest address first), so
        // signerPks[0..1] in order produces the canonical ordering.
        bytes memory combined = _combine([signerPks[0], signerPks[1]], message);
        bytes4 result = multisig.isValidSignature(
            _hashMessage(message),
            combined
        );
        assertEq(uint32(result), uint32(EIP1271_MAGIC));
    }

    function test_returnsMagicValueWithAllSigners() public view {
        bytes32 message = keccak256("msg-all");
        bytes memory s0 = _signEthMsg(signerPks[0], message);
        bytes memory s1 = _signEthMsg(signerPks[1], message);
        bytes memory s2 = _signEthMsg(signerPks[2], message);
        bytes memory combined = bytes.concat(s0, s1, s2);
        bytes4 result = multisig.isValidSignature(
            _hashMessage(message),
            combined
        );
        assertEq(uint32(result), uint32(EIP1271_MAGIC));
    }

    function test_returnsInvalidForInsufficientSignatures() public view {
        bytes32 hash = keccak256("insufficient");
        bytes memory single = _signEthMsg(signerPks[0], hash);
        bytes4 result = multisig.isValidSignature(hash, single);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }

    function test_returnsInvalidForSignaturesFromNonSigners() public {
        (, uint256 nonSignerPk) = makeAddrAndKey("nonSignerKey");
        bytes32 hash = keccak256("non-signer");
        bytes memory s0 = _signEthMsg(signerPks[0], hash);
        bytes memory sNon = _signEthMsg(nonSignerPk, hash);
        // The combined signatures must be in ascending address order; the contract
        // rejects if the addresses recovered aren't strictly increasing, so we
        // build the order based on actual recovered addresses.
        bytes memory combined;
        if (signerAddresses[0] < vm.addr(nonSignerPk)) {
            combined = bytes.concat(s0, sNon);
        } else {
            combined = bytes.concat(sNon, s0);
        }
        bytes4 result = multisig.isValidSignature(hash, combined);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }

    function test_returnsInvalidForSignaturesNotInAscendingOrder() public view {
        bytes32 hash = keccak256("order");
        // Descending = sig[2] then sig[1].
        bytes memory s2 = _signEthMsg(signerPks[2], hash);
        bytes memory s1 = _signEthMsg(signerPks[1], hash);
        bytes memory combined = bytes.concat(s2, s1);
        bytes4 result = multisig.isValidSignature(hash, combined);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }

    function test_returnsInvalidForDuplicateSignatures() public view {
        bytes32 hash = keccak256("duplicate");
        bytes memory s0 = _signEthMsg(signerPks[0], hash);
        bytes memory combined = bytes.concat(s0, s0);
        bytes4 result = multisig.isValidSignature(hash, combined);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }

    function test_returnsInvalidForWrongHashSignature() public view {
        bytes32 hash1 = keccak256("hash1");
        bytes32 hash2 = keccak256("hash2");
        bytes memory combined = _combine([signerPks[0], signerPks[1]], hash2);
        bytes4 result = multisig.isValidSignature(hash1, combined);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }

    function test_returnsInvalidForMalformedSignaturesInsteadOfReverting()
        public
        view
    {
        bytes32 hash = keccak256("malformed");
        bytes memory combined = _combine([signerPks[0], signerPks[1]], hash);
        // Corrupt the v byte of the first signature.
        combined[64] = bytes1(uint8(0));
        bytes4 result = multisig.isValidSignature(hash, combined);
        assertEq(uint32(result), uint32(EIP1271_INVALID));
    }
}
