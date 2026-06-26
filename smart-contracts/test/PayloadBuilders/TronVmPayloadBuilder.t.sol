// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {
  BuildPayloadParams,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  CallRequest,
  TronVmPayloadBuilder
} from "../../contracts/payload-builders/TronVmPayloadBuilder.sol";

contract TronVmPayloadBuilderTest is BaseTest {
  uint256 internal constant EXPIRATION_DELAY_SECONDS = 10 * 24 * 60 * 60;

  Config internal config;
  TronVmPayloadBuilder internal payloadBuilder;

  function setUp() public override {
    super.setUp();

    RelayHub hub = new RelayHub(owner);
    RelayAllocator allocator = new RelayAllocator(
      owner,
      address(hub),
      address(0)
    );
    config = new Config(address(allocator));
    payloadBuilder = new TronVmPayloadBuilder(address(config));

    bytes32 expirationKey = payloadBuilder.getExpirationKey();
    vm.prank(owner);
    config.setConfigValue(expirationKey, bytes32(EXPIRATION_DELAY_SECONDS));
  }

  /// @notice Tron addresses are 21 bytes: a `0x41` prefix byte followed by a 20-byte EVM address
  function toTronAddress(address account) internal pure returns (bytes memory) {
    return abi.encodePacked(bytes1(0x41), account);
  }

  function test_buildsEthereumVmCompatiblePayload() public {
    address receiver = otherAccounts[0];
    uint256 amount = 0.1 ether;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: toTronAddress(address(0)),
      amount: amount,
      receiver: toTronAddress(receiver),
      nonce: 1,
      data: ""
    });

    bytes memory payload = payloadBuilder.buildPayload(
      "tron-mainnet",
      toTronAddress(otherAccounts[1]),
      params
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertEq(decoded.calls.length, 1);
    assertEq(decoded.calls[0].to, receiver);
    assertEq(decoded.calls[0].value, amount);
    assertFalse(decoded.calls[0].allowFailure);
  }

  function test_namespacesConfigKeysWithTronVmPrefix() public view {
    assertEq(
      payloadBuilder.getEvmChainIdKey("tron-mainnet"),
      keccak256(abi.encodePacked(keccak256("TRON_VM_CHAIN_ID"), "tron-mainnet"))
    );
    assertEq(
      payloadBuilder.getExpirationKey(),
      keccak256("TRON_VM_EXPIRATION")
    );
  }

  function test_returnsExpectedMetadata() public view {
    assertEq(payloadBuilder.curve(), "Ecdsa");
    assertEq(payloadBuilder.family(), "tron-vm");
  }
}
