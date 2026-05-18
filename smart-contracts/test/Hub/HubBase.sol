// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";

/// @notice Shared fixture for Hub tests. Mirrors `deployHub` patterns from the
/// original TypeScript Hub test files.
abstract contract HubBase is BaseTest {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 internal constant EDITOR_ROLE = keccak256("EDITOR_ROLE");

    address internal admin;
    RelayHub internal hub;

    function setUp() public virtual override {
        super.setUp();
        admin = owner;
        hub = new RelayHub(admin);
    }
}
