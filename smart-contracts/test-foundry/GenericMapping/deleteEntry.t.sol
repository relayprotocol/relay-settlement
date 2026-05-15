// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GenericMappingBase} from "./GenericMappingBase.sol";
import {RelayGenericMapping} from "../../contracts/RelayGenericMapping.sol";

/// @notice Port of test/GenericMapping/deleteEntry.ts.
contract GenericMappingDeleteEntryTest is GenericMappingBase {
    bytes32 internal constant ID_1 = keccak256("entry1");
    bytes32 internal constant ID_2 = keccak256("entry2");
    bytes32 internal constant SET_NONCE = keccak256("nonce-1");
    bytes32 internal constant DELETE_NONCE = keccak256("nonce-2");
    bytes32 internal constant EXTRA_NONCE = keccak256("nonce-3");

    function _setEntry(
        address user,
        bytes32 id,
        bytes memory data,
        bytes32 nonce
    ) internal {
        bytes memory sig = _signSet(oraclePk, user, id, data, nonce);
        vm.prank(caller);
        store.setEntry(user, id, data, nonce, oracle, sig);
    }

    function test_allowsAnyoneToDeleteWithValidOracleSignature() public {
        bytes memory data = bytes("data1");
        _setEntry(caller, ID_1, data, SET_NONCE);

        bytes memory deleteSig = _signDelete(
            oraclePk,
            caller,
            ID_1,
            DELETE_NONCE
        );
        vm.prank(caller);
        store.deleteEntry(caller, ID_1, DELETE_NONCE, oracle, deleteSig);

        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_1);
        assertEq(got.length, 0);
        assertEq(createdAt, 0);
    }

    function test_emitsEntryDeletedEvent() public {
        bytes memory data = bytes("data1");
        _setEntry(caller, ID_1, data, SET_NONCE);

        vm.expectEmit(true, true, false, true, address(store));
        emit RelayGenericMapping.EntryDeleted(caller, ID_1);

        vm.prank(caller);
        store.deleteEntry(
            caller,
            ID_1,
            DELETE_NONCE,
            oracle,
            _signDelete(oraclePk, caller, ID_1, DELETE_NONCE)
        );
    }

    function test_doesNotAffectOtherEntries() public {
        bytes memory data1 = bytes("data1");
        bytes memory data2 = bytes("data2");

        _setEntry(caller, ID_1, data1, SET_NONCE);
        _setEntry(caller, ID_2, data2, DELETE_NONCE);

        bytes memory sig = _signDelete(oraclePk, caller, ID_1, EXTRA_NONCE);
        vm.prank(caller);
        store.deleteEntry(caller, ID_1, EXTRA_NONCE, oracle, sig);

        (bytes memory got1, uint256 deletedAt) = store.getEntry(caller, ID_1);
        assertEq(got1.length, 0);
        assertEq(deletedAt, 0);
        (bytes memory got2, ) = store.getEntry(caller, ID_2);
        assertEq(got2, data2);
    }

    function test_revertsNonceAlreadyUsedWhenReplayingSignature() public {
        bytes memory data = bytes("data1");
        _setEntry(caller, ID_1, data, SET_NONCE);

        bytes memory deleteSig = _signDelete(
            oraclePk,
            caller,
            ID_1,
            DELETE_NONCE
        );
        vm.prank(caller);
        store.deleteEntry(caller, ID_1, DELETE_NONCE, oracle, deleteSig);

        // Re-create the entry so the delete would otherwise be valid.
        _setEntry(caller, ID_1, data, EXTRA_NONCE);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.NonceAlreadyUsed.selector,
                DELETE_NONCE
            )
        );
        store.deleteEntry(caller, ID_1, DELETE_NONCE, oracle, deleteSig);
    }

    function test_revertsUnauthorizedOracleOnDelete() public {
        bytes memory data = bytes("data1");
        _setEntry(caller, ID_1, data, SET_NONCE);

        bytes memory sig = _signDelete(
            unauthorizedOraclePk,
            caller,
            ID_1,
            DELETE_NONCE
        );

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.UnauthorizedOracle.selector,
                unauthorizedOracle
            )
        );
        store.deleteEntry(
            caller,
            ID_1,
            DELETE_NONCE,
            unauthorizedOracle,
            sig
        );
    }

    function test_revertsInvalidOracleSignatureOnDelete() public {
        bytes memory data = bytes("data1");
        _setEntry(caller, ID_1, data, SET_NONCE);

        bytes memory wrongSig = _signDelete(
            unauthorizedOraclePk,
            caller,
            ID_1,
            DELETE_NONCE
        );

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.InvalidOracleSignature.selector,
                oracle
            )
        );
        store.deleteEntry(caller, ID_1, DELETE_NONCE, oracle, wrongSig);
    }

    function test_revertsEntryNotFoundWhenMissing() public {
        bytes32 missingId = keccak256("nonexistent");
        bytes memory sig = _signDelete(
            oraclePk,
            caller,
            missingId,
            DELETE_NONCE
        );

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.EntryNotFound.selector,
                caller,
                missingId
            )
        );
        store.deleteEntry(caller, missingId, DELETE_NONCE, oracle, sig);
    }

    function test_revertsWhenDeleteIdIsZero() public {
        bytes32 zeroId = bytes32(0);
        bytes memory sig = _signDelete(oraclePk, caller, zeroId, DELETE_NONCE);

        vm.prank(caller);
        vm.expectRevert(RelayGenericMapping.EmptyId.selector);
        store.deleteEntry(caller, zeroId, DELETE_NONCE, oracle, sig);
    }
}
