// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";

/// @notice Port of test/ERC20View/autoCreate.ts.
contract ERC20ViewAutoCreationTest is ERC20ViewBase {
    function test_automaticallyCreatesErc20ViewOnFirstTokenOperation() public {
        uint256 tokenId = 999;

        assertEq(hub.erc20Views(tokenId), address(0));

        vm.expectEmit(true, false, false, false, address(hub));
        // Indexed arg #1 (tokenId) must match; indexed arg #2 (erc20View) is
        // the CREATE2 address and ignored via `checkData=false` semantics.
        emit RelayHub.ERC20ViewCreated(tokenId, address(0));

        _mint(regularUser, tokenId, 100);

        address after_ = hub.erc20Views(tokenId);
        assertTrue(after_ != address(0));
    }

    function test_createsErc20ViewForDifferentTokenIds() public {
        uint256 tokenId1 = 111;
        uint256 tokenId2 = 222;

        _mint(regularUser, tokenId1, 100);
        _mint(regularUser, tokenId2, 100);

        address a1 = hub.erc20Views(tokenId1);
        address a2 = hub.erc20Views(tokenId2);

        assertTrue(a1 != address(0));
        assertTrue(a2 != address(0));
        assertTrue(a1 != a2);
    }
}
