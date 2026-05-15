// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HubBase} from "./HubBase.sol";

/// @notice Port of test/Hub/mint.ts.
contract HubMintTest is HubBase {
    address internal operatorUser;
    address internal regularUser;

    function setUp() public virtual override {
        super.setUp();
        operatorUser = otherAccounts[0];
        regularUser = otherAccounts[1];
        vm.prank(admin);
        hub.grantRole(OPERATOR_ROLE, operatorUser);
    }

    function test_allowsOperatorToMintTokensToAnyAddress() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.prank(operatorUser);
        hub.mint(regularUser, tokenId, amount);

        assertEq(hub.balanceOf(regularUser, tokenId), amount);
    }

    function test_revertsWhenNonOracleTriesToMintTokens() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.prank(regularUser);
        vm.expectRevert();
        hub.mint(regularUser, tokenId, amount);
    }

    function test_emitsTransferEventWithCorrectParameters() public {
        uint256 tokenId = 1;
        uint256 amount = 100;

        vm.recordLogs();
        vm.prank(operatorUser);
        hub.mint(regularUser, tokenId, amount);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("Transfer(address,address,address,uint256,uint256)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hub) && logs[i].topics[0] == sig) {
                address from = address(uint160(uint256(logs[i].topics[1])));
                address to = address(uint160(uint256(logs[i].topics[2])));
                uint256 id = uint256(logs[i].topics[3]);
                (address caller, uint256 amt) = abi.decode(logs[i].data, (address, uint256));
                if (id == tokenId && amt == amount) {
                    assertEq(caller, operatorUser);
                    assertEq(from, address(0));
                    assertEq(to, regularUser);
                    found = true;
                }
            }
        }
        assertTrue(found);
    }

    function test_allowsMintingMultipleTokensWithDifferentIds() public {
        uint256 tokenId1 = 1;
        uint256 tokenId2 = 2;
        uint256 amount1 = 100;
        uint256 amount2 = 200;

        vm.startPrank(operatorUser);
        hub.mint(regularUser, tokenId1, amount1);
        hub.mint(regularUser, tokenId2, amount2);
        vm.stopPrank();

        assertEq(hub.balanceOf(regularUser, tokenId1), amount1);
        assertEq(hub.balanceOf(regularUser, tokenId2), amount2);
    }
}
