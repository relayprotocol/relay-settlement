// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {RelayAllocator} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";

/// @notice Port of test/Config/Config.ts. 1:1 mapping with the original
/// `describe("Config") / it(...)` blocks.
contract ConfigTest is BaseTest {
    Config internal config;
    RelayAllocator internal allocator;
    RelayAllocator internal replacementAllocator;
    RelayHub internal hub;

    bytes32 internal constant KEY_ETHEREUM = keccak256("ethereum-mainnet");
    bytes32 internal constant KEY_BASE = keccak256("base-mainnet");
    bytes32 internal constant KEY_MISSING = keccak256("missing-key");

    function setUp() public override {
        super.setUp();
        hub = new RelayHub(owner);
        allocator = new RelayAllocator(owner, address(hub));
        replacementAllocator = new RelayAllocator(newOwner, address(hub));
        config = new Config(address(allocator));
    }

    function _value(uint256 v) internal pure returns (bytes32) {
        return bytes32(v);
    }

    function test_setsAndReadsASingleValue() public {
        bytes32 value = _value(1);

        vm.prank(owner);
        config.setConfigValue(KEY_ETHEREUM, value);

        assertEq(config.getConfigValue(KEY_ETHEREUM), value);
    }

    function test_setsMultipleValues() public {
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = KEY_ETHEREUM;
        keys[1] = KEY_BASE;

        bytes32[] memory values = new bytes32[](2);
        values[0] = _value(1);
        values[1] = _value(8453);

        vm.prank(owner);
        config.setConfigValues(keys, values);

        assertEq(config.getConfigValue(keys[0]), values[0]);
        assertEq(config.getConfigValue(keys[1]), values[1]);
    }

    function test_revertsWhenReadingAnUnsetKey() public {
        vm.expectRevert(abi.encodeWithSelector(Config.ConfigValueNotSet.selector, KEY_MISSING));
        config.getConfigValue(KEY_MISSING);
    }

    function test_rejectsNonOwnerSingleWrites() public {
        bytes32 value = _value(1);

        vm.prank(otherAccounts[0]);
        vm.expectRevert(abi.encodeWithSelector(Config.CallerIsNotAllocatorOwner.selector, otherAccounts[0]));
        config.setConfigValue(KEY_ETHEREUM, value);
    }

    function test_rejectsNonOwnerBatchWrites() public {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = KEY_ETHEREUM;
        bytes32[] memory values = new bytes32[](1);
        values[0] = _value(1);

        vm.prank(otherAccounts[0]);
        vm.expectRevert(abi.encodeWithSelector(Config.CallerIsNotAllocatorOwner.selector, otherAccounts[0]));
        config.setConfigValues(keys, values);
    }

    function test_revertsWhenBatchArrayLengthsDoNotMatch() public {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = KEY_ETHEREUM;
        bytes32[] memory values = new bytes32[](2);
        values[0] = _value(1);
        values[1] = _value(8453);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Config.ArrayLengthMismatch.selector, uint256(1), uint256(2)));
        config.setConfigValues(keys, values);
    }

    function test_allowsCurrentAllocatorOwnerToUpdateAllocator() public {
        vm.prank(owner);
        config.setAllocator(address(replacementAllocator));

        assertEq(config.allocator(), address(replacementAllocator));
    }

    function test_rejectsAllocatorUpdatesFromNonOwnerAccounts() public {
        vm.prank(otherAccounts[0]);
        vm.expectRevert(abi.encodeWithSelector(Config.CallerIsNotAllocatorOwner.selector, otherAccounts[0]));
        config.setAllocator(address(replacementAllocator));
    }

    function test_usesReplacementAllocatorOwnerForSubsequentWrites() public {
        bytes32 value = _value(1);

        vm.prank(owner);
        config.setAllocator(address(replacementAllocator));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Config.CallerIsNotAllocatorOwner.selector, owner));
        config.setConfigValue(KEY_ETHEREUM, value);

        vm.prank(newOwner);
        config.setConfigValue(KEY_ETHEREUM, value);
        assertEq(config.getConfigValue(KEY_ETHEREUM), value);
    }

    function test_rejectsTheZeroAddressAsReplacementAllocator() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Config.InvalidAllocator.selector, address(0)));
        config.setAllocator(address(0));
    }

    function test_rejectsAnEoaAsReplacementAllocator() public {
        // The original test asserts only that the call reverts (no specific
        // selector) — passing an EOA causes the `try` in _validateAllocator to
        // fall into the catch branch.
        vm.prank(owner);
        vm.expectRevert();
        config.setAllocator(otherAccounts[0]);
    }

    function test_rejectsContractWithoutOwnerAsReplacementAllocator() public {
        // RelayHub uses AccessControl and has no owner() function, so the
        // try/catch in Config falls through to InvalidAllocator.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Config.InvalidAllocator.selector, address(hub)));
        config.setAllocator(address(hub));
    }
}
