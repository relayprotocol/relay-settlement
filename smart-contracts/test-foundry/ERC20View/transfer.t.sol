// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/ERC20View/transfer.ts.
contract ERC20ViewTransferTest is ERC20ViewBase {
    uint256 internal constant TOKEN_ID = 1;
    address internal anotherUser;
    ERC20View internal view_;

    function setUp() public override {
        super.setUp();
        anotherUser = otherAccounts[2];
        _mint(regularUser, TOKEN_ID, 100);
        view_ = _erc20View(TOKEN_ID);
    }

    function test_transfersTokensCorrectlyViaErc20View() public {
        uint256 fromBefore = hub.balanceOf(regularUser, TOKEN_ID);
        uint256 toBefore = hub.balanceOf(anotherUser, TOKEN_ID);

        vm.prank(regularUser);
        view_.transfer(anotherUser, 25);

        assertEq(hub.balanceOf(regularUser, TOKEN_ID), fromBefore - 25);
        assertEq(hub.balanceOf(anotherUser, TOKEN_ID), toBefore + 25);
    }

    function test_revertsWhenTryingToTransferMoreThanBalance() public {
        uint256 currentBalance = hub.balanceOf(regularUser, TOKEN_ID);
        vm.prank(regularUser);
        vm.expectRevert();
        view_.transfer(anotherUser, currentBalance + 1);
    }

    function test_emitsTransferEventWithCorrectParameters() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 15);
        vm.prank(regularUser);
        view_.transfer(anotherUser, 15);
    }

    function test_allowsTransferToZeroAddress() public {
        uint256 before_ = hub.balanceOf(regularUser, TOKEN_ID);
        vm.prank(regularUser);
        view_.transfer(address(0), 10);
        assertEq(hub.balanceOf(regularUser, TOKEN_ID), before_ - 10);
    }
}
