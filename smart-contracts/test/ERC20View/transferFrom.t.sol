// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/ERC20View/transferFrom.ts.
contract ERC20ViewTransferFromTest is ERC20ViewBase {
    uint256 internal constant TOKEN_ID = 1;
    address internal anotherUser;
    ERC20View internal view_;

    function setUp() public override {
        super.setUp();
        anotherUser = otherAccounts[2];
        _mint(regularUser, TOKEN_ID, 1000);
        view_ = _erc20View(TOKEN_ID);
    }

    function test_transfersTokensCorrectlyWithValidAllowance() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 100);

        uint256 fromBefore = hub.balanceOf(regularUser, TOKEN_ID);
        uint256 toBefore = hub.balanceOf(anotherUser, TOKEN_ID);

        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 50);

        assertEq(hub.balanceOf(regularUser, TOKEN_ID), fromBefore - 50);
        assertEq(hub.balanceOf(anotherUser, TOKEN_ID), toBefore + 50);
    }

    function test_preventsUnauthorizedTransferFromWithoutAllowance() public {
        vm.prank(anotherUser);
        vm.expectRevert();
        view_.transferFrom(regularUser, anotherUser, 100);
    }

    function test_preventsTransferFromWhenAllowanceIsInsufficient() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 50);

        vm.prank(anotherUser);
        vm.expectRevert();
        view_.transferFrom(regularUser, anotherUser, 51);
    }

    function test_properlyUpdatesAllowanceAfterSuccessfulTransferFrom() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 100);

        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 30);

        assertEq(view_.allowance(regularUser, anotherUser), 70);
    }

    function test_doesNotUpdateUnlimitedAllowance() public {
        uint256 unlimited = type(uint256).max;
        vm.prank(regularUser);
        view_.approve(anotherUser, unlimited);

        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 100);

        assertEq(view_.allowance(regularUser, anotherUser), unlimited);
    }

    function test_allowsOwnerToTransferWithoutAllowanceCheck() public {
        vm.prank(regularUser);
        view_.transferFrom(regularUser, anotherUser, 50);

        assertEq(view_.balanceOf(anotherUser), 50);
    }

    function test_maintainsAllowanceConsistencyBetweenHubAndErc20View() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 200);

        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 75);

        uint256 expected = 200 - 75;
        assertEq(hub.allowance(regularUser, anotherUser, TOKEN_ID), expected);
        assertEq(view_.allowance(regularUser, anotherUser), expected);
    }

    function test_emitsTransferEventWithCorrectParameters() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 100);

        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 25);
        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 25);
    }

    function test_handlesZeroAmountTransferCorrectly() public {
        vm.prank(regularUser);
        view_.approve(anotherUser, 100);

        vm.prank(anotherUser);
        view_.transferFrom(regularUser, anotherUser, 0);

        assertEq(view_.allowance(regularUser, anotherUser), 100);
    }
}
