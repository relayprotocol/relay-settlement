// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/burn.ts.
contract HubBurnTest is HubBase {
    address internal operatorUser;
    address internal regularUser;

    function setUp() public virtual override {
        super.setUp();
        operatorUser = otherAccounts[0];
        regularUser = otherAccounts[1];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
    }

    function test_allowsOperatorToBurnTokensFromAnyAddress() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.startPrank(operatorUser);
        hub.mint(regularUser, tokenId, amount);
        hub.burn(regularUser, tokenId, amount);
        vm.stopPrank();

        assertEq(hub.balanceOf(regularUser, tokenId), 0);
    }

    function test_revertsWhenNonOperatorTriesToBurnTokens() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.prank(operatorUser);
        hub.mint(regularUser, tokenId, amount);

        vm.prank(regularUser);
        vm.expectRevert();
        hub.burn(regularUser, tokenId, amount);
    }

    function test_emitsTransferEventWithCorrectParameters() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.prank(operatorUser);
        hub.mint(regularUser, tokenId, amount);

        vm.recordLogs();
        vm.prank(operatorUser);
        hub.burn(regularUser, tokenId, amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Transfer(address,address,address,uint256,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == sig) {
                address from = address(uint160(uint256(logs[i].topics[1])));
                address to = address(uint160(uint256(logs[i].topics[2])));
                uint256 id = uint256(logs[i].topics[3]);
                (address caller, uint256 amt) = abi.decode(logs[i].data, (address, uint256));
                if (to == address(0) && id == tokenId && amt == amount) {
                    assertEq(caller, operatorUser);
                    assertEq(from, regularUser);
                    found = true;
                }
            }
        }
        assertTrue(found);
    }

    function test_revertsWhenTryingToBurnMoreTokensThanAvailable() public {
        uint256 tokenId = 1;
        uint256 mintAmount = 100;
        uint256 burnAmount = 200;

        vm.prank(operatorUser);
        hub.mint(regularUser, tokenId, mintAmount);

        vm.prank(operatorUser);
        vm.expectRevert(); // arithmetic underflow (panic 0x11)
        hub.burn(regularUser, tokenId, burnAmount);
    }
}
