// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GenericMappingBase} from "./GenericMappingBase.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayGenericMapping} from "../../contracts/RelayGenericMapping.sol";

/// @notice Pins the digests produced by the SDK v2.4 generic mapping helpers
/// (packages/sdk/test/generic-mapping-v2.4.test.ts); drift means the SDK and
/// the contract disagree on what the oracle signs.
contract GenericMappingSdkFixtureTest is GenericMappingBase {
    address internal constant FIXTURE_MAPPING =
        0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f;
    address internal constant FIXTURE_USER =
        0x1111111111111111111111111111111111111111;
    bytes32 internal constant FIXTURE_ID =
        0xabababababababababababababababababababababababababababababababab;
    bytes32 internal constant FIXTURE_NONCE =
        0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd;
    uint256 internal constant FIXTURE_EXPIRATION = 1_900_000_000;

    bytes32 internal constant SDK_SET_ENTRY_HASH =
        0xb6ee0ceb64cc2faa20c3d5ac09c31beb824c63dd4596190ee08fde8e6967ab7f;
    bytes32 internal constant SDK_DELETE_ENTRY_HASH =
        0x8a5f0aff443f45827a3c734c569b3d81dc5617bf7fad7f8556ab2a3f30b9e6a3;

    function setUp() public override {
        super.setUp();
        assertEq(block.chainid, 31337);

        // Same contract at the SDK fixture address
        deployCodeTo(
            "RelayGenericMapping.sol:RelayGenericMapping",
            abi.encode(admin, address(0)),
            FIXTURE_MAPPING
        );
        store = RelayGenericMapping(FIXTURE_MAPPING);
        domainSep = Eip712.domainSeparator(
            "RelayGenericMapping",
            "1",
            block.chainid,
            FIXTURE_MAPPING
        );
        expiration = FIXTURE_EXPIRATION;

        bytes32 oracleRole = store.ORACLE_ROLE();
        vm.prank(admin);
        store.grantRole(oracleRole, oracle);
    }

    function test_setEntryHashMatchesSdkFixture() public {
        bytes memory data = hex"0102";
        assertEq(
            Eip712.digest(
                domainSep,
                _setEntryStructHash(FIXTURE_USER, FIXTURE_ID, data, FIXTURE_NONCE)
            ),
            SDK_SET_ENTRY_HASH
        );

        // The contract accepts an oracle signature over the SDK digest
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, SDK_SET_ENTRY_HASH);
        store.setEntry(
            FIXTURE_USER,
            FIXTURE_ID,
            data,
            FIXTURE_NONCE,
            FIXTURE_EXPIRATION,
            oracle,
            abi.encodePacked(r, s, v)
        );
        (bytes memory got, ) = store.getEntry(FIXTURE_USER, FIXTURE_ID);
        assertEq(got, data);
    }

    function test_deleteEntryHashMatchesSdkFixture() public {
        assertEq(
            Eip712.digest(
                domainSep,
                _deleteEntryStructHash(FIXTURE_USER, FIXTURE_ID, FIXTURE_NONCE)
            ),
            SDK_DELETE_ENTRY_HASH
        );

        bytes32 setNonce = keccak256("set-nonce");
        store.setEntry(
            FIXTURE_USER,
            FIXTURE_ID,
            hex"0102",
            setNonce,
            FIXTURE_EXPIRATION,
            oracle,
            _signSet(oraclePk, FIXTURE_USER, FIXTURE_ID, hex"0102", setNonce)
        );

        // The contract accepts an oracle signature over the SDK digest
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            oraclePk,
            SDK_DELETE_ENTRY_HASH
        );
        store.deleteEntry(
            FIXTURE_USER,
            FIXTURE_ID,
            FIXTURE_NONCE,
            FIXTURE_EXPIRATION,
            oracle,
            abi.encodePacked(r, s, v)
        );
        (, uint256 createdAt) = store.getEntry(FIXTURE_USER, FIXTURE_ID);
        assertEq(createdAt, 0);
    }
}
