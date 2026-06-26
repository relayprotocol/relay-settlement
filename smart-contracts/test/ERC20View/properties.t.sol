// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20ViewBase} from "./ERC20ViewBase.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Port of test/ERC20View/properties.ts.
contract ERC20ViewPropertiesTest is ERC20ViewBase {
    function test_createsErc20ViewWithCorrectDefaultNameSymbolAndDecimals()
        public
    {
        uint256 tokenId = 999;
        string memory expectedName = "Hub Token #999";
        string memory expectedSymbol = "HTK999";
        uint8 expectedDecimals = 18;

        _setMetadata(tokenId, expectedName, expectedSymbol, expectedDecimals);
        _mint(regularUser, tokenId, 100);

        ERC20View view_ = _erc20View(tokenId);
        assertEq(view_.name(), expectedName);
        assertEq(view_.symbol(), expectedSymbol);
        assertEq(view_.decimals(), expectedDecimals);
    }
}
