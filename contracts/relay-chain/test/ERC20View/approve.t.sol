// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";

/// @notice Port of test/ERC20View/approve.ts.
contract ERC20ViewApproveTest is ERC20ViewBase {
    uint256 internal constant TOKEN_ID = 1;
    address internal anotherUser;
    ERC20View internal view_;

    function setUp() public override {
        super.setUp();
        anotherUser = otherAccounts[2];
        _mint(regularUser, TOKEN_ID, 100);
        view_ = _erc20View(TOKEN_ID);
    }

    function test_approvesSpenderCorrectly() public {
        vm.prank(regularUser);
        view_.approve(operatorUser, 50);
        assertEq(view_.allowance(regularUser, operatorUser), 50);
    }

    function test_updatesAllowanceWhenApproveCalledAgain() public {
        vm.prank(regularUser);
        view_.approve(operatorUser, 50);
        assertEq(view_.allowance(regularUser, operatorUser), 50);

        vm.prank(regularUser);
        view_.approve(operatorUser, 75);
        assertEq(view_.allowance(regularUser, operatorUser), 75);
    }

    function test_emitsApprovalEventWithCorrectParameters() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Approval(regularUser, operatorUser, 50);
        vm.prank(regularUser);
        view_.approve(operatorUser, 50);
    }

    function test_allowsApprovalToZeroAddress() public {
        vm.prank(regularUser);
        view_.approve(address(0), 50);
        assertEq(view_.allowance(regularUser, address(0)), 50);
    }

    function test_storesAllowanceInHubAndErc20ViewReadsFromHub() public {
        vm.prank(regularUser);
        view_.approve(operatorUser, 50);

        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 50);
        assertEq(view_.allowance(regularUser, operatorUser), 50);
    }

    function test_hubApproveTriggersErc20ViewApprovalEvent() public {
        // Hub.Approval is emitted with (owner, spender, id, amount) — only
        // (owner, spender, id) are indexed.
        vm.expectEmit(true, true, true, true, address(hub));
        emit RelayHub.Approval(regularUser, operatorUser, TOKEN_ID, 75);
        // ERC20View.Approval is emitted as well, indexed (owner, spender) +
        // data (value).
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Approval(regularUser, operatorUser, 75);

        vm.prank(regularUser);
        hub.approve(operatorUser, TOKEN_ID, 75);

        assertEq(view_.allowance(regularUser, operatorUser), 75);
    }

    function test_erc20ViewApproveTriggersBothHubAndErc20ViewEvents() public {
        vm.expectEmit(true, true, true, true, address(hub));
        emit RelayHub.Approval(regularUser, operatorUser, TOKEN_ID, 60);
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Approval(regularUser, operatorUser, 60);

        vm.prank(regularUser);
        view_.approve(operatorUser, 60);
    }

    function test_allowanceConsistencyAcrossMultipleOperations() public {
        vm.prank(regularUser);
        view_.approve(operatorUser, 100);
        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 100);
        assertEq(view_.allowance(regularUser, operatorUser), 100);

        vm.prank(regularUser);
        hub.approve(operatorUser, TOKEN_ID, 200);
        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 200);
        assertEq(view_.allowance(regularUser, operatorUser), 200);

        vm.prank(regularUser);
        view_.approve(operatorUser, 0);
        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 0);
        assertEq(view_.allowance(regularUser, operatorUser), 0);
    }

    function test_preventsUnauthorizedCallsToHubApproveFor() public {
        vm.prank(anotherUser);
        vm.expectRevert();
        hub.approveFor(regularUser, operatorUser, TOKEN_ID, 100);
    }

    function test_preventsNonOwnerFromSettingAllowanceViaErc20View() public {
        // anotherUser calls approve — this works and sets allowance on
        // anotherUser, not on regularUser.
        vm.prank(anotherUser);
        view_.approve(operatorUser, 100);
        assertEq(view_.allowance(anotherUser, operatorUser), 100);
    }

    function test_handlesMaximumAllowanceCorrectly() public {
        uint256 maxAllowance = type(uint256).max;
        vm.prank(regularUser);
        view_.approve(operatorUser, maxAllowance);
        assertEq(view_.allowance(regularUser, operatorUser), maxAllowance);
    }

    function test_handlesZeroAllowanceCorrectly() public {
        vm.startPrank(regularUser);
        view_.approve(operatorUser, 100);
        view_.approve(operatorUser, 0);
        vm.stopPrank();

        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 0);
        assertEq(view_.allowance(regularUser, operatorUser), 0);
    }

    function test_preservesAllowanceDataIntegrityAcrossDifferentTokenIds()
        public
    {
        uint256 tokenId2 = 2;
        _mint(regularUser, tokenId2, 100);

        vm.prank(regularUser);
        view_.approve(operatorUser, 50);

        vm.prank(regularUser);
        hub.approve(operatorUser, tokenId2, 75);

        assertEq(hub.allowance(regularUser, operatorUser, TOKEN_ID), 50);
        assertEq(hub.allowance(regularUser, operatorUser, tokenId2), 75);
    }
}
