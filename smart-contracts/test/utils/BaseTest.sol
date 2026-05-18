// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Common fixture for Foundry tests in the migration from Hardhat.
/// Mirrors the `[owner, otherAccounts]` slot layout produced by
/// `await hre.viem.getWalletClients()` in the original TypeScript suite so
/// individual ports stay close to the originals.
abstract contract BaseTest is Test {
    address internal owner;
    address internal newOwner;
    address[10] internal otherAccounts;

    function setUp() public virtual {
        owner = makeAddr("owner");
        newOwner = makeAddr("newOwner");
        for (uint256 i; i < otherAccounts.length; ++i) {
            otherAccounts[i] = makeAddr(string.concat("other-", vm.toString(i)));
        }
    }
}
