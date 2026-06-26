// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/ERC20View/directEvents.ts.
contract ERC20ViewDirectEventsTest is ERC20ViewBase {
    uint256 internal constant TOKEN_ID = 1;
    address internal anotherUser;
    ERC20View internal view_;

    function setUp() public override {
        super.setUp();
        anotherUser = otherAccounts[2];
        _mint(regularUser, TOKEN_ID, 100);
        view_ = _erc20View(TOKEN_ID);
    }

    function test_emitsApprovalEventOnErc20ViewApprove() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Approval(regularUser, anotherUser, 50);
        vm.prank(regularUser);
        view_.approve(anotherUser, 50);
    }

    function test_emitsTransferEventOnErc20ViewTransfer() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 25);
        vm.prank(regularUser);
        view_.transfer(anotherUser, 25);
    }

    function test_emitsTransferEventOnErc20ViewTransferFrom() public {
        vm.prank(regularUser);
        view_.approve(admin, 50);

        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 25);
        vm.prank(admin);
        view_.transferFrom(regularUser, anotherUser, 25);
    }
}
