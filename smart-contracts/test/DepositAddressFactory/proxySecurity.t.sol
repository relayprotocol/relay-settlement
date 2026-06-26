// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DepositAddressFactoryBase} from "./DepositAddressFactoryBase.sol";
import {DepositAddress} from "../../contracts/deposit-addresses/strict/ethereum/DepositAddress.sol";

/// @notice Port of test/DepositAddressFactory/proxySecurity.ts.
contract DepositAddressFactoryImmutablesThroughDelegatecallTest is DepositAddressFactoryBase {
    function test_readsCorrectDepositoryThroughProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        DepositAddress proxy = DepositAddress(payable(predicted));
        assertEq(proxy.DEPOSITORY(), address(depository));
    }

    function test_readsCorrectFactoryThroughProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        DepositAddress proxy = DepositAddress(payable(predicted));
        assertEq(proxy.FACTORY(), address(factory));
    }
}

contract DepositAddressFactoryImplementationIsolationTest is DepositAddressFactoryBase {
    function test_revertsWhenCallingSweepOnImplementationDirectly() public {
        vm.prank(deployer);
        token.transfer(address(sweeper), 500);

        vm.expectRevert(DepositAddress.OnlyFactory.selector);
        sweeper.sweep(address(token), depositor, orderId);
    }

    function test_doesNotAllowFundsOnImplementationToBeSweptViaProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        vm.prank(deployer);
        token.transfer(address(sweeper), 500);

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        factory.sweep(orderId, depositor, tokens);

        assertEq(token.balanceOf(address(sweeper)), 500);
        assertEq(token.balanceOf(predicted), 0);
    }

    function test_doesNotAllowEthOnImplementationToBeSweptViaProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);

        vm.deal(address(sweeper), 1 ether);

        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        factory.sweep(orderId, depositor, tokens);

        assertEq(address(sweeper).balance, 1 ether);
        assertEq(predicted.balance, 0);
    }
}

contract DepositAddressFactoryProxyBytecodeIntegrityTest is DepositAddressFactoryBase {
    function test_deploysValidEip1167MinimalProxy() public {
        address predicted = factory.computeDepositAddress(orderId, depositor);
        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);

        bytes memory code = predicted.code;
        address implementation = factory.IMPLEMENTATION();

        bytes memory expected = abi.encodePacked(
            hex"3d3d3d3d363d3d37363d73",
            bytes20(implementation),
            hex"5af43d3d93803e602a57fd5bf3"
        );
        assertEq(code, expected);
    }

    function test_pointsAllProxiesToSameImplementation() public {
        address predicted1 = factory.computeDepositAddress(orderId, depositor);
        address predicted2 = factory.computeDepositAddress(orderId, anyone);

        address[] memory empty = new address[](0);
        factory.sweep(orderId, depositor, empty);
        factory.sweep(orderId, anyone, empty);

        assertEq(predicted1.code, predicted2.code);
    }
}
