// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HubBase} from "./HubBase.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";

/// @notice Port of test/Hub/extensions.ts (metadata + content URI extensions).
contract HubMetadataExtensionTest is HubBase {
    address internal editor;
    address internal attacker;

    function setUp() public virtual override {
        super.setUp();
        editor = otherAccounts[0];
        attacker = otherAccounts[1];
    }

    function test_shouldNotLetAnyoneSetMetadata() public {
        RelayHub.TokenMetadata memory metadata = RelayHub.TokenMetadata({
            name: "New Token",
            symbol: "NT",
            decimals: 18,
            originFamily: "ethereum-vm",
            originChainId: 1,
            originAsset: "0x0000000000000000000000000000000000000000"
        });
        vm.prank(attacker);
        vm.expectRevert();
        hub.setTokenMetadata(1, metadata);
    }

    function test_shouldHaveDefaultMetadataForEachToken() public view {
        assertEq(hub.name(1), "");
        assertEq(hub.symbol(1), "");
        assertEq(hub.decimals(1), 18);
    }

    function test_shouldLetAddressWithEditorRoleSetMetadata() public {
        vm.prank(admin);
        hub.grantRole(EDITOR_ROLE, editor);

        RelayHub.TokenMetadata memory metadata = RelayHub.TokenMetadata({
            name: "New Token",
            symbol: "NT",
            decimals: 6,
            originFamily: "ethereum-vm",
            originChainId: 1,
            originAsset: "0x0000000000000000000000000000000000000000"
        });
        vm.prank(editor);
        hub.setTokenMetadata(1, metadata);

        assertEq(hub.name(1), "New Token");
        assertEq(hub.symbol(1), "NT");
        assertEq(hub.decimals(1), 6);

        (
            string memory name,
            string memory symbol,
            uint8 decimals,
            string memory originFamily,
            uint256 originChainId,
            string memory originAsset
        ) = hub.tokenMetadata(1);
        assertEq(name, "New Token");
        assertEq(symbol, "NT");
        assertEq(decimals, 6);
        assertEq(originFamily, "ethereum-vm");
        assertEq(originChainId, 1);
        assertEq(originAsset, "0x0000000000000000000000000000000000000000");
    }
}

contract HubContentUriExtensionTest is HubBase {
    address internal editor;
    address internal attacker;

    function setUp() public virtual override {
        super.setUp();
        editor = otherAccounts[0];
        attacker = otherAccounts[1];
    }

    function test_shouldNotLetAnyoneSetContractUri() public {
        vm.prank(attacker);
        vm.expectRevert();
        hub.setContractURI("https://new-uri.com");
    }

    function test_shouldHaveDefaultContractUriAndTokenUriForEachToken() public view {
        assertEq(hub.contractURI(), "");
        assertEq(hub.tokenURI(1), "/1");
    }

    function test_shouldLetAddressWithEditorRoleSetContractUri() public {
        vm.prank(admin);
        hub.grantRole(EDITOR_ROLE, editor);

        vm.prank(editor);
        hub.setContractURI("https://new-uri.com");

        assertEq(hub.contractURI(), "https://new-uri.com");
        assertEq(hub.tokenURI(1), "https://new-uri.com/1");
    }
}
