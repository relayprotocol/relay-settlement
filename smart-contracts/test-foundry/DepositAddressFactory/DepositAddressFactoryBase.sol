// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {DepositAddressFactory} from "../../contracts/deposit-addresses/strict/ethereum/DepositAddressFactory.sol";
import {DepositAddress} from "../../contracts/deposit-addresses/strict/ethereum/DepositAddress.sol";
import {RelayDepository} from "../../contracts/depository/RelayDepository.sol";
import {MyToken} from "../../contracts/test-utils/MyToken.sol";

/// @notice Port of test/DepositAddressFactory/fixtures.ts.
abstract contract DepositAddressFactoryBase is BaseTest {
    address internal deployer;
    address internal depositor;
    address internal anyone;

    RelayDepository internal depository;
    DepositAddressFactory internal factory;
    DepositAddress internal sweeper;
    MyToken internal token;
    bytes32 internal orderId;

    function setUp() public virtual override {
        super.setUp();
        deployer = owner;
        depositor = otherAccounts[0];
        anyone = otherAccounts[1];

        vm.startPrank(deployer);
        depository = new RelayDepository(deployer, deployer);
        factory = new DepositAddressFactory(address(depository));
        sweeper = DepositAddress(payable(factory.IMPLEMENTATION()));
        token = new MyToken();
        vm.stopPrank();

        orderId = keccak256(bytes("order-1"));
    }
}
