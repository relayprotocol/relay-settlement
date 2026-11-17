// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayInboxMultisigBase} from "./RelayInboxMultisigBase.sol";
import {RelayInboxMultisig} from "../../contracts/RelayInboxMultisig.sol";

/// @notice Port of test/RelayInboxMultisig/deployment.ts.
contract RelayInboxMultisigDeploymentTest is RelayInboxMultisigBase {
    function test_deploysWithValidSignersAndThreshold() public {
        RelayInboxMultisig multisig = _defaultMultisig();

        assertEq(multisig.threshold(), 2);
        assertEq(multisig.getSignerCount(), 3);
        assertEq(multisig.owner(), multisigOwner);
        for (uint256 i = 0; i < signerAddresses.length; i++) {
            assertTrue(multisig.isSigner(signerAddresses[i]));
        }
    }

    function test_emitsSignerAddedEventForEachSigner() public {
        for (uint256 i = 0; i < signerAddresses.length; i++) {
            vm.expectEmit(true, false, false, false);
            emit RelayInboxMultisig.SignerAdded(signerAddresses[i]);
        }
        _defaultMultisig();
    }

    function test_revertsWithZeroThreshold() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayInboxMultisig.InvalidThreshold.selector,
                uint256(0),
                uint256(3)
            )
        );
        _deploy(signerAddresses, 0);
    }

    function test_revertsWithThresholdGreaterThanSignerCount() public {
        address[] memory twoSigners = new address[](2);
        twoSigners[0] = signerAddresses[0];
        twoSigners[1] = signerAddresses[1];

        vm.expectRevert(
            abi.encodeWithSelector(
                RelayInboxMultisig.InvalidThreshold.selector,
                uint256(3),
                uint256(2)
            )
        );
        _deploy(twoSigners, 3);
    }

    function test_revertsWithEmptySignerList() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayInboxMultisig.InvalidThreshold.selector,
                uint256(1),
                uint256(0)
            )
        );
        _deploy(empty, 1);
    }

    function test_revertsWithZeroAddressAsSigner() public {
        address[] memory withZero = new address[](2);
        withZero[0] = signerAddresses[0];
        withZero[1] = address(0);
        vm.expectRevert(RelayInboxMultisig.InvalidSignerAddress.selector);
        _deploy(withZero, 1);
    }

    function test_revertsWithDuplicateSigners() public {
        address[] memory dup = new address[](2);
        dup[0] = signerAddresses[0];
        dup[1] = signerAddresses[0];
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayInboxMultisig.SignerAlreadyExists.selector,
                signerAddresses[0]
            )
        );
        _deploy(dup, 1);
    }

    function test_ownership_setsCorrectOwnerAtDeployment() public {
        RelayInboxMultisig multisig = _defaultMultisig();
        assertEq(multisig.owner(), multisigOwner);
    }

    function test_ownership_allowsOwnerToInitiateTransfer() public {
        RelayInboxMultisig multisig = _defaultMultisig();
        vm.prank(multisigOwner);
        multisig.transferOwnership(newOwner);
        assertEq(multisig.pendingOwner(), newOwner);
        assertEq(multisig.owner(), multisigOwner);
    }

    function test_ownership_allowsPendingOwnerToAccept() public {
        RelayInboxMultisig multisig = _defaultMultisig();
        vm.prank(multisigOwner);
        multisig.transferOwnership(newOwner);

        vm.prank(newOwner);
        multisig.acceptOwnership();
        assertEq(multisig.owner(), newOwner);
        assertEq(multisig.pendingOwner(), address(0));
    }

    function test_ownership_rejectsNonPendingOwnerFromAccepting() public {
        RelayInboxMultisig multisig = _defaultMultisig();
        vm.prank(multisigOwner);
        multisig.transferOwnership(newOwner);

        vm.prank(otherAccounts[3]);
        vm.expectRevert();
        multisig.acceptOwnership();
    }

    function test_ownership_allowsOwnerToRenounce() public {
        RelayInboxMultisig multisig = _defaultMultisig();
        vm.prank(multisigOwner);
        multisig.renounceOwnership();
        assertEq(multisig.owner(), address(0));
    }
}
