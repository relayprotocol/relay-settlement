// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";

/// @notice Shared fixture for the ERC20View Foundry tests. Mirrors the
/// `deployHub` / `deployHubWithERC20View` setup blocks used across
/// test/ERC20View/*.ts.
abstract contract ERC20ViewBase is BaseTest {
    RelayHub internal hub;

    address internal admin;
    address internal operatorUser;
    address internal regularUser;

    function setUp() public virtual override {
        super.setUp();
        admin = owner;
        operatorUser = otherAccounts[0];
        regularUser = otherAccounts[1];

        hub = new RelayHub(admin);

        bytes32 operatorRole = hub.OPERATOR_ROLE();
        bytes32 editorRole = hub.EDITOR_ROLE();
        vm.startPrank(admin);
        hub.grantRole(operatorRole, operatorUser);
        hub.grantRole(editorRole, admin);
        vm.stopPrank();
    }

    function _mint(address to, uint256 tokenId, uint256 amount) internal {
        vm.prank(operatorUser);
        hub.mint(to, tokenId, amount);
    }

    function _burn(address from, uint256 tokenId, uint256 amount) internal {
        vm.prank(operatorUser);
        hub.burn(from, tokenId, amount);
    }

    function _setMetadata(
        uint256 tokenId,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) internal {
        RelayHub.TokenMetadata memory md = RelayHub.TokenMetadata({
            name: name_,
            symbol: symbol_,
            decimals: decimals_,
            originFamily: "ethereum-vm",
            originChainId: 1,
            originAsset: "0x0000000000000000000000000000000000000000"
        });
        vm.prank(admin);
        hub.setTokenMetadata(tokenId, md);
    }

    function _erc20View(uint256 tokenId) internal view returns (ERC20View) {
        return ERC20View(hub.erc20Views(tokenId));
    }
}
