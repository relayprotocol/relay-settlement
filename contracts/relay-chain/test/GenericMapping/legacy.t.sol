// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GenericMappingBase} from "./GenericMappingBase.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayGenericMapping} from "../../contracts/RelayGenericMapping.sol";

/// @notice Read-through of entries stored in a legacy RelayGenericMapping.
contract RelayGenericMappingLegacyTest is GenericMappingBase {
    bytes32 internal constant ID_1 = keccak256("entry1");
    bytes32 internal constant ID_2 = keccak256("entry2");

    RelayGenericMapping internal legacy;
    bytes32 internal legacyDomainSep;
    uint256 internal nonceCounter;

    function setUp() public override {
        super.setUp();

        legacy = new RelayGenericMapping(admin, address(0));
        legacyDomainSep = Eip712.domainSeparator(
            "RelayGenericMapping",
            "1",
            block.chainid,
            address(legacy)
        );
        bytes32 oracleRole = legacy.ORACLE_ROLE();
        vm.prank(admin);
        legacy.grantRole(oracleRole, oracle);

        _legacySet(caller, ID_1, bytes("legacy-1"));
        vm.warp(block.timestamp + 1 days);

        store = new RelayGenericMapping(admin, address(legacy));
        domainSep = Eip712.domainSeparator(
            "RelayGenericMapping",
            "1",
            block.chainid,
            address(store)
        );
        expiration = block.timestamp + 1 hours;
        vm.prank(admin);
        store.grantRole(oracleRole, oracle);
    }

    function _nextNonce() internal returns (bytes32) {
        return keccak256(abi.encode("nonce", ++nonceCounter));
    }

    function _legacySet(address user, bytes32 id, bytes memory data) internal {
        bytes32 nonce = _nextNonce();
        bytes memory sig = Eip712.sign(
            oraclePk,
            legacyDomainSep,
            _setEntryStructHash(user, id, data, nonce)
        );
        legacy.setEntry(user, id, data, nonce, expiration, oracle, sig);
    }

    function _set(address user, bytes32 id, bytes memory data) internal {
        bytes32 nonce = _nextNonce();
        bytes memory sig = _signSet(oraclePk, user, id, data, nonce);
        store.setEntry(user, id, data, nonce, expiration, oracle, sig);
    }

    function _delete(address user, bytes32 id) internal {
        bytes32 nonce = _nextNonce();
        bytes memory sig = _signDelete(oraclePk, user, id, nonce);
        store.deleteEntry(user, id, nonce, expiration, oracle, sig);
    }

    function test_constructorRejectsLegacyWithoutCode() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(RelayGenericMapping.InvalidLegacy.selector, eoa)
        );
        new RelayGenericMapping(admin, eoa);
    }

    function test_exposesLegacy() public view {
        assertEq(address(store.LEGACY()), address(legacy));
    }

    function test_getEntryReadsThroughWithLegacyCreatedAt() public view {
        (bytes memory data, uint256 createdAt) = legacy.getEntry(caller, ID_1);
        (bytes memory got, uint256 gotCreatedAt) = store.getEntry(caller, ID_1);
        assertEq(got, data);
        assertEq(gotCreatedAt, createdAt);
        assertLt(gotCreatedAt, block.timestamp);
    }

    function test_getEntryReturnsEmptyWhenMissingInBoth() public view {
        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_2);
        assertEq(got.length, 0);
        assertEq(createdAt, 0);
    }

    function test_setEntryRejectsLiveLegacyEntry() public {
        bytes32 nonce = _nextNonce();
        bytes memory data = bytes("new");
        bytes memory sig = _signSet(oraclePk, caller, ID_1, data, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.EntryAlreadyExists.selector,
                caller,
                ID_1
            )
        );
        store.setEntry(caller, ID_1, data, nonce, expiration, oracle, sig);
    }

    function test_deleteEntryShadowsLegacyEntry() public {
        vm.expectEmit(true, true, false, false, address(store));
        emit RelayGenericMapping.EntryDeleted(caller, ID_1);
        _delete(caller, ID_1);

        assertTrue(store.legacyEntryDeleted(caller, ID_1));
        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_1);
        assertEq(got.length, 0);
        assertEq(createdAt, 0);

        // The legacy mapping itself is untouched
        (, uint256 legacyCreatedAt) = legacy.getEntry(caller, ID_1);
        assertGt(legacyCreatedAt, 0);
    }

    function test_deleteEntryRevertsWhenMissingInBoth() public {
        bytes32 nonce = _nextNonce();
        bytes memory sig = _signDelete(oraclePk, caller, ID_2, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.EntryNotFound.selector,
                caller,
                ID_2
            )
        );
        store.deleteEntry(caller, ID_2, nonce, expiration, oracle, sig);
    }

    function test_deleteEntryRevertsOnceLegacyEntryDeleted() public {
        _delete(caller, ID_1);

        bytes32 nonce = _nextNonce();
        bytes memory sig = _signDelete(oraclePk, caller, ID_1, nonce);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayGenericMapping.EntryNotFound.selector,
                caller,
                ID_1
            )
        );
        store.deleteEntry(caller, ID_1, nonce, expiration, oracle, sig);
    }

    function test_setEntryAfterDeletingLegacyEntryStoresLocally() public {
        _delete(caller, ID_1);
        _set(caller, ID_1, bytes("replacement"));

        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_1);
        assertEq(got, bytes("replacement"));
        assertEq(createdAt, block.timestamp);
    }

    function test_deletingReplacementDoesNotResurrectLegacyEntry() public {
        _delete(caller, ID_1);
        _set(caller, ID_1, bytes("replacement"));
        _delete(caller, ID_1);

        (bytes memory got, uint256 createdAt) = store.getEntry(caller, ID_1);
        assertEq(got.length, 0);
        assertEq(createdAt, 0);
    }

    function test_localEntryWithoutLegacyCounterpart() public {
        _set(caller, ID_2, bytes("local"));
        (bytes memory got, ) = store.getEntry(caller, ID_2);
        assertEq(got, bytes("local"));

        _delete(caller, ID_2);
        (, uint256 createdAt) = store.getEntry(caller, ID_2);
        assertEq(createdAt, 0);
    }

    function test_readsThroughChainedLegacies() public {
        RelayGenericMapping next = new RelayGenericMapping(admin, address(store));
        (bytes memory data, uint256 createdAt) = legacy.getEntry(caller, ID_1);
        (bytes memory got, uint256 gotCreatedAt) = next.getEntry(caller, ID_1);
        assertEq(got, data);
        assertEq(gotCreatedAt, createdAt);
    }

    function test_deleteWithoutLegacyDoesNotRecordShadow() public {
        RelayGenericMapping standalone = new RelayGenericMapping(admin, address(0));
        bytes32 oracleRole = standalone.ORACLE_ROLE();
        vm.prank(admin);
        standalone.grantRole(oracleRole, oracle);
        bytes32 standaloneDomainSep = Eip712.domainSeparator(
            "RelayGenericMapping",
            "1",
            block.chainid,
            address(standalone)
        );

        bytes32 setNonce = _nextNonce();
        standalone.setEntry(
            caller,
            ID_2,
            bytes("x"),
            setNonce,
            expiration,
            oracle,
            Eip712.sign(
                oraclePk,
                standaloneDomainSep,
                _setEntryStructHash(caller, ID_2, bytes("x"), setNonce)
            )
        );
        bytes32 deleteNonce = _nextNonce();
        standalone.deleteEntry(
            caller,
            ID_2,
            deleteNonce,
            expiration,
            oracle,
            Eip712.sign(
                oraclePk,
                standaloneDomainSep,
                _deleteEntryStructHash(caller, ID_2, deleteNonce)
            )
        );

        assertFalse(standalone.legacyEntryDeleted(caller, ID_2));
    }
}
