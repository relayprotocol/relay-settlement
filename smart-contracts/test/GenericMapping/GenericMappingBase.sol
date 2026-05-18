// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {RelayGenericMapping} from "../../contracts/RelayGenericMapping.sol";

/// @notice Shared fixture for the GenericMapping Foundry tests. Mirrors the
/// `setup()` blocks used by test/GenericMapping/*.ts.
abstract contract GenericMappingBase is BaseTest {
    RelayGenericMapping internal store;

    address internal admin;
    address internal caller;

    address internal oracle;
    uint256 internal oraclePk;

    address internal unauthorizedOracle;
    uint256 internal unauthorizedOraclePk;

    bytes32 internal domainSep;

    function setUp() public virtual override {
        super.setUp();

        admin = owner;
        caller = otherAccounts[0];

        (oracle, oraclePk) = makeAddrAndKey("oracle");
        (unauthorizedOracle, unauthorizedOraclePk) = makeAddrAndKey(
            "unauthorizedOracle"
        );

        store = new RelayGenericMapping(admin);
        domainSep = Eip712.domainSeparator(
            "RelayGenericMapping",
            "1",
            block.chainid,
            address(store)
        );

        bytes32 oracleRole = store.ORACLE_ROLE();
        vm.prank(admin);
        store.grantRole(oracleRole, oracle);
    }

    function _setEntryStructHash(
        address user,
        bytes32 id,
        bytes memory data,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    store.SET_ENTRY_TYPEHASH(),
                    user,
                    id,
                    keccak256(data),
                    nonce
                )
            );
    }

    function _deleteEntryStructHash(
        address user,
        bytes32 id,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    store.DELETE_ENTRY_TYPEHASH(),
                    user,
                    id,
                    nonce
                )
            );
    }

    function _signSet(
        uint256 pk,
        address user,
        bytes32 id,
        bytes memory data,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        return Eip712.sign(pk, domainSep, _setEntryStructHash(user, id, data, nonce));
    }

    function _signDelete(
        uint256 pk,
        address user,
        bytes32 id,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        return Eip712.sign(pk, domainSep, _deleteEntryStructHash(user, id, nonce));
    }
}
