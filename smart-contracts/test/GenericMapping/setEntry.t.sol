// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GenericMappingBase} from "./GenericMappingBase.sol";
import {RelayGenericMapping} from "../../contracts/RelayGenericMapping.sol";

/// @notice Port of test/GenericMapping/setEntry.ts.
contract GenericMappingSetEntryTest is GenericMappingBase {
    bytes32 internal constant ID_1 = keccak256("entry1");
    bytes32 internal constant ID_2 = keccak256("entry2");
    bytes32 internal constant NONCE_1 = keccak256("nonce-1");
    bytes32 internal constant NONCE_2 = keccak256("nonce-2");
    bytes32 internal constant NONCE_3 = keccak256("nonce-3");

    function test_allowsAnyoneToSetEntryWithValidOracleSignature() public {
        bytes memory data = bytes("data1");
        bytes memory sig = _signSet(oraclePk, caller, ID_1, data, NONCE_1);

        vm.prank(caller);
        store.setEntry(caller, ID_1, data, NONCE_1, oracle, sig);

        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_1);
        assertEq(got, data);
        assertGt(createdAt, 0);
    }

    function test_emitsEntrySetEvent() public {
        bytes memory data = bytes("data1");
        bytes memory sig = _signSet(oraclePk, caller, ID_1, data, NONCE_1);

        vm.expectEmit(true, true, false, true, address(store));
        emit RelayGenericMapping.EntrySet(caller, ID_1, data);

        vm.prank(caller);
        store.setEntry(caller, ID_1, data, NONCE_1, oracle, sig);
    }

    function test_revertsEntryAlreadyExistsWhenEntrySet() public {
        bytes memory data1 = bytes("data1");
        bytes memory data2 = bytes("data2");

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data1,
            NONCE_1,
            oracle,
            _signSet(oraclePk, caller, ID_1, data1, NONCE_1)
        );

        bytes memory sig2 = _signSet(oraclePk, caller, ID_1, data2, NONCE_2);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.EntryAlreadyExists.selector,
                caller,
                ID_1
            )
        );
        store.setEntry(caller, ID_1, data2, NONCE_2, oracle, sig2);
    }

    function test_allowsSettingAfterDelete() public {
        bytes memory data1 = bytes("data1");
        bytes memory data2 = bytes("data2");

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data1,
            NONCE_1,
            oracle,
            _signSet(oraclePk, caller, ID_1, data1, NONCE_1)
        );

        vm.prank(caller);
        store.deleteEntry(
            caller,
            ID_1,
            NONCE_2,
            oracle,
            _signDelete(oraclePk, caller, ID_1, NONCE_2)
        );

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data2,
            NONCE_3,
            oracle,
            _signSet(oraclePk, caller, ID_1, data2, NONCE_3)
        );

        (bytes memory got, ) = store.getEntry(caller, ID_1);
        assertEq(got, data2);
    }

    function test_storesSeparateEntriesForSameUserDifferentIds() public {
        bytes memory data1 = bytes("data1");
        bytes memory data2 = bytes("data2");

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data1,
            NONCE_1,
            oracle,
            _signSet(oraclePk, caller, ID_1, data1, NONCE_1)
        );

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_2,
            data2,
            NONCE_2,
            oracle,
            _signSet(oraclePk, caller, ID_2, data2, NONCE_2)
        );

        (bytes memory got1, ) = store.getEntry(caller, ID_1);
        (bytes memory got2, ) = store.getEntry(caller, ID_2);
        assertEq(got1, data1);
        assertEq(got2, data2);
    }

    function test_storesSeparateEntriesForDifferentUsersSameId() public {
        address user2 = otherAccounts[1];
        bytes memory data1 = bytes("data1");
        bytes memory data2 = bytes("data2");

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data1,
            NONCE_1,
            oracle,
            _signSet(oraclePk, caller, ID_1, data1, NONCE_1)
        );

        vm.prank(caller);
        store.setEntry(
            user2,
            ID_1,
            data2,
            NONCE_2,
            oracle,
            _signSet(oraclePk, user2, ID_1, data2, NONCE_2)
        );

        (bytes memory got1, ) = store.getEntry(caller, ID_1);
        (bytes memory got2, ) = store.getEntry(user2, ID_1);
        assertEq(got1, data1);
        assertEq(got2, data2);
    }

    function test_revertsNonceAlreadyUsedWhenReplayingNonce() public {
        bytes memory data = bytes("data1");

        vm.prank(caller);
        store.setEntry(
            caller,
            ID_1,
            data,
            NONCE_1,
            oracle,
            _signSet(oraclePk, caller, ID_1, data, NONCE_1)
        );

        bytes memory sig2 = _signSet(oraclePk, caller, ID_2, data, NONCE_1);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.NonceAlreadyUsed.selector,
                NONCE_1
            )
        );
        store.setEntry(caller, ID_2, data, NONCE_1, oracle, sig2);
    }

    function test_revertsUnauthorizedOracleWhenLacksRole() public {
        bytes memory data = bytes("data1");
        bytes memory sig = _signSet(
            unauthorizedOraclePk,
            caller,
            ID_1,
            data,
            NONCE_1
        );

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.UnauthorizedOracle.selector,
                unauthorizedOracle
            )
        );
        store.setEntry(
            caller,
            ID_1,
            data,
            NONCE_1,
            unauthorizedOracle,
            sig
        );
    }

    function test_revertsInvalidOracleSignatureWhenSignerMismatch() public {
        bytes memory data = bytes("data1");
        bytes memory wrongSig = _signSet(
            unauthorizedOraclePk,
            caller,
            ID_1,
            data,
            NONCE_1
        );

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.InvalidOracleSignature.selector,
                oracle
            )
        );
        store.setEntry(caller, ID_1, data, NONCE_1, oracle, wrongSig);
    }

    function test_revertsInvalidOracleSignatureWhenParamsTampered() public {
        bytes memory data = bytes("data1");
        bytes memory tampered = bytes("tampered");
        bytes memory sig = _signSet(oraclePk, caller, ID_1, tampered, NONCE_1);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.InvalidOracleSignature.selector,
                oracle
            )
        );
        store.setEntry(caller, ID_1, data, NONCE_1, oracle, sig);
    }

    function test_revertsWhenDataIsEmpty() public {
        bytes memory empty;
        bytes memory sig = _signSet(oraclePk, caller, ID_1, empty, NONCE_1);

        vm.prank(caller);
        vm.expectRevert(RelayGenericMapping.EmptyData.selector);
        store.setEntry(caller, ID_1, empty, NONCE_1, oracle, sig);
    }

    function test_revertsWhenIdIsZero() public {
        bytes memory data = bytes("data1");
        bytes32 zeroId = bytes32(0);
        bytes memory sig = _signSet(oraclePk, caller, zeroId, data, NONCE_1);

        vm.prank(caller);
        vm.expectRevert(RelayGenericMapping.EmptyId.selector);
        store.setEntry(caller, zeroId, data, NONCE_1, oracle, sig);
    }

    function test_returnsEmptyForNonExistentEntry() public view {
        (bytes memory got, uint256 createdAt) = store.getEntry(
            caller,
            keccak256("nonexistent")
        );
        assertEq(got.length, 0);
        assertEq(createdAt, 0);
    }
}
