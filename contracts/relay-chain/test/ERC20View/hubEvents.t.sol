// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/ERC20View/hubEvents.ts.
contract ERC20ViewHubEventsTest is ERC20ViewBase {
    uint256 internal constant TOKEN_ID = 1;
    address internal anotherUser;
    ERC20View internal view_;

    function setUp() public override {
        super.setUp();
        anotherUser = otherAccounts[2];
        _mint(regularUser, TOKEN_ID, 100);
        view_ = _erc20View(TOKEN_ID);
    }

    function test_emitsTransferEventOnHubTransfer() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 10);
        vm.prank(regularUser);
        hub.transfer(anotherUser, TOKEN_ID, 10);
    }

    function test_emitsTransferEventOnHubTransferFrom() public {
        vm.prank(regularUser);
        hub.approve(anotherUser, TOKEN_ID, 50);

        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 10);
        vm.prank(anotherUser);
        hub.transferFrom(regularUser, anotherUser, TOKEN_ID, 10);
    }

    function test_emitsTransferEventOnHubMint() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(address(0), regularUser, 50);
        _mint(regularUser, TOKEN_ID, 50);
    }

    function test_emitsTransferEventOnHubBurn() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, address(0), 10);
        _burn(regularUser, TOKEN_ID, 10);
    }

    function test_emitsMultipleTransferEventsForMultipleHubTransfers() public {
        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 10);
        vm.prank(regularUser);
        hub.transfer(anotherUser, TOKEN_ID, 10);

        vm.expectEmit(true, true, false, true, address(view_));
        emit ERC20View.Transfer(regularUser, anotherUser, 15);
        vm.prank(regularUser);
        hub.transfer(anotherUser, TOKEN_ID, 15);
    }

    function test_doesNotEmitDuplicateEventsWhenSenderIsErc20View() public {
        vm.recordLogs();
        vm.prank(regularUser);
        view_.transfer(anotherUser, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Count Transfer events FROM the ERC20View contract for this token.
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(view_) && logs[i].topics.length > 0 && logs[i].topics[0] == transferSig) {
                count++;
            }
        }
        assertEq(count, 1);
    }

    function test_verifiesTransferEventEmittedExactlyOnceFromErc20ViewTransferFrom()
        public
    {
        vm.prank(regularUser);
        view_.approve(admin, 50);

        vm.recordLogs();
        vm.prank(admin);
        view_.transferFrom(regularUser, anotherUser, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(view_) && logs[i].topics.length > 0 && logs[i].topics[0] == transferSig) {
                count++;
                assertEq(
                    address(uint160(uint256(logs[i].topics[1]))),
                    regularUser
                );
                assertEq(
                    address(uint160(uint256(logs[i].topics[2]))),
                    anotherUser
                );
                assertEq(abi.decode(logs[i].data, (uint256)), 10);
            }
        }
        assertEq(count, 1);
    }
}

