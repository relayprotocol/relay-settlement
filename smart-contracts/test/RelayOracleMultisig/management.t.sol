// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RelayOracleMultisigBase} from "./RelayOracleMultisigBase.sol";
import {RelayOracleMultisig} from "../../contracts/RelayOracleMultisig.sol";

/// @notice Port of test/RelayOracleMultisig/management.ts.
contract RelayOracleMultisigManagementTest is RelayOracleMultisigBase {
    RelayOracleMultisig internal multisig;

    function setUp() public override {
        super.setUp();
        multisig = _defaultMultisig();
    }

    // addSigner

    function test_addSigner_byOwner() public {
        vm.prank(multisigOwner);
        multisig.addSigner(newSignerAddr);
        assertTrue(multisig.isSigner(newSignerAddr));
        assertEq(multisig.getSignerCount(), 4);
    }

    function test_addSigner_emitsSignerAddedEvent() public {
        vm.expectEmit(true, false, false, false);
        emit RelayOracleMultisig.SignerAdded(newSignerAddr);
        vm.prank(multisigOwner);
        multisig.addSigner(newSignerAddr);
    }

    function test_addSigner_revertsWhenExisting() public {
        vm.prank(multisigOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracleMultisig.SignerAlreadyExists.selector,
                signerAddresses[0]
            )
        );
        multisig.addSigner(signerAddresses[0]);
    }

    function test_addSigner_revertsOnZeroAddress() public {
        vm.prank(multisigOwner);
        vm.expectRevert(RelayOracleMultisig.InvalidSignerAddress.selector);
        multisig.addSigner(address(0));
    }

    function test_addSigner_revertsForNonOwner() public {
        vm.prank(nonSigner);
        vm.expectRevert();
        multisig.addSigner(newSignerAddr);
    }

    // removeSigner

    function test_removeSigner_byOwner() public {
        vm.prank(multisigOwner);
        multisig.removeSigner(signerAddresses[2]);
        assertFalse(multisig.isSigner(signerAddresses[2]));
        assertEq(multisig.getSignerCount(), 2);
    }

    function test_removeSigner_emitsSignerRemovedEvent() public {
        vm.expectEmit(true, false, false, false);
        emit RelayOracleMultisig.SignerRemoved(signerAddresses[2]);
        vm.prank(multisigOwner);
        multisig.removeSigner(signerAddresses[2]);
    }

    function test_removeSigner_revertsWhenNonExistent() public {
        vm.prank(multisigOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracleMultisig.SignerDoesNotExist.selector,
                nonSigner
            )
        );
        multisig.removeSigner(nonSigner);
    }

    function test_removeSigner_revertsWhenWouldMakeThresholdImpossible() public {
        vm.startPrank(multisigOwner);
        multisig.removeSigner(signerAddresses[2]); // 3 -> 2 (threshold = 2)
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracleMultisig.InvalidThreshold.selector,
                uint256(2),
                uint256(1)
            )
        );
        multisig.removeSigner(signerAddresses[1]); // would leave 1 signer
        vm.stopPrank();
    }

    function test_removeSigner_revertsOnLastSigner() public {
        vm.startPrank(multisigOwner);
        multisig.setThreshold(1);
        multisig.removeSigner(signerAddresses[2]);
        multisig.removeSigner(signerAddresses[1]);
        vm.expectRevert(RelayOracleMultisig.CannotRemoveLastSigner.selector);
        multisig.removeSigner(signerAddresses[0]);
        vm.stopPrank();
    }

    function test_removeSigner_revertsForNonOwner() public {
        vm.prank(nonSigner);
        vm.expectRevert();
        multisig.removeSigner(signerAddresses[0]);
    }

    // setThreshold

    function test_setThreshold_byOwner() public {
        vm.prank(multisigOwner);
        multisig.setThreshold(3);
        assertEq(multisig.threshold(), 3);
    }

    function test_setThreshold_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit RelayOracleMultisig.ThresholdChanged(2, 1);
        vm.prank(multisigOwner);
        multisig.setThreshold(1);
    }

    function test_setThreshold_revertsOnZero() public {
        vm.prank(multisigOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracleMultisig.InvalidThreshold.selector,
                uint256(0),
                uint256(3)
            )
        );
        multisig.setThreshold(0);
    }

    function test_setThreshold_revertsGreaterThanSignerCount() public {
        vm.prank(multisigOwner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RelayOracleMultisig.InvalidThreshold.selector,
                uint256(10),
                uint256(3)
            )
        );
        multisig.setThreshold(10);
    }

    function test_setThreshold_revertsForNonOwner() public {
        vm.prank(nonSigner);
        vm.expectRevert();
        multisig.setThreshold(1);
    }

    function test_combined_allowsMultipleManagementOpsInSequence() public {
        vm.startPrank(multisigOwner);
        multisig.addSigner(newSignerAddr);
        assertEq(multisig.getSignerCount(), 4);

        multisig.setThreshold(3);
        assertEq(multisig.threshold(), 3);

        multisig.removeSigner(signerAddresses[2]);
        assertEq(multisig.getSignerCount(), 3);

        multisig.setThreshold(2);
        assertEq(multisig.threshold(), 2);
        vm.stopPrank();
    }
}
