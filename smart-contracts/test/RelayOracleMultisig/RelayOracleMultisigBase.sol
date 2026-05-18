// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {RelayOracleMultisig} from "../../contracts/RelayOracleMultisig.sol";

/// @notice Shared fixture for the RelayOracleMultisig Foundry tests.
/// Mirrors the per-describe setup blocks used in test/RelayOracleMultisig/*.ts.
abstract contract RelayOracleMultisigBase is BaseTest {
    address internal multisigOwner;

    address[] internal signerAddresses; // sorted ascending
    uint256[] internal signerPks;

    address internal nonSigner;
    address internal newSignerAddr;
    address internal otherWalletAddr;

    bytes4 internal constant EIP1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant EIP1271_INVALID = 0x00000000;

    function setUp() public virtual override {
        super.setUp();
        multisigOwner = owner;

        (address s1, uint256 pk1) = makeAddrAndKey("signer1");
        (address s2, uint256 pk2) = makeAddrAndKey("signer2");
        (address s3, uint256 pk3) = makeAddrAndKey("signer3");

        address[3] memory s = _sortAscending(s1, s2, s3);
        uint256[3] memory pks = _pksOrderedBy(s, s1, s2, s3, pk1, pk2, pk3);

        signerAddresses = new address[](3);
        signerPks = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            signerAddresses[i] = s[i];
            signerPks[i] = pks[i];
        }

        nonSigner = otherAccounts[0];
        newSignerAddr = otherAccounts[1];
        otherWalletAddr = otherAccounts[2];
    }

    function _sortAscending(
        address a,
        address b,
        address c
    ) internal pure returns (address[3] memory result) {
        address[3] memory arr = [a, b, c];
        for (uint256 i = 0; i < 2; i++) {
            for (uint256 j = 0; j < 2 - i; j++) {
                if (arr[j] > arr[j + 1]) {
                    (arr[j], arr[j + 1]) = (arr[j + 1], arr[j]);
                }
            }
        }
        result = arr;
    }

    function _pksOrderedBy(
        address[3] memory sortedAddrs,
        address a1,
        address a2,
        address a3,
        uint256 p1,
        uint256 p2,
        uint256 p3
    ) internal pure returns (uint256[3] memory result) {
        for (uint256 i = 0; i < 3; i++) {
            address target = sortedAddrs[i];
            if (target == a1) result[i] = p1;
            else if (target == a2) result[i] = p2;
            else if (target == a3) result[i] = p3;
            else revert("sort error");
        }
    }

    function _deploy(
        address[] memory signers,
        uint256 threshold
    ) internal returns (RelayOracleMultisig) {
        return new RelayOracleMultisig(multisigOwner, signers, threshold);
    }

    function _defaultMultisig() internal returns (RelayOracleMultisig) {
        return _deploy(signerAddresses, 2);
    }
}
