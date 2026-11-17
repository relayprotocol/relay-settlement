// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {GatewayVmPayloadBuilderBase} from "./GatewayVmPayloadBuilder.t.sol";
import {Config} from "../../contracts/Config.sol";
import {
  GatewayVmPayloadBuilder,
  GatewayVmPayloadData,
  GatewayVmPayload
} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {WithdrawRequest} from "../../contracts/RelayAllocator.sol";

abstract contract GatewayVmMaxBlockHeightBase is GatewayVmPayloadBuilderBase {
  function _paramsWithHeight(
    uint256 height
  ) internal view returns (WithdrawRequest memory params) {
    params = _params();
    GatewayVmPayloadData memory data = abi.decode(
      params.data,
      (GatewayVmPayloadData)
    );
    data.maxBlockHeight = height;
    params.data = abi.encode(data);
  }

  function _buildWithHeight(
    uint256 height
  ) internal view returns (GatewayVmPayload memory) {
    return
      abi.decode(
        buildPayloadOnly(
          builder,
          CHAIN_ID,
          abi.encodePacked(evmDestinationDepository),
          _paramsWithHeight(height)
        ),
        (GatewayVmPayload)
      );
  }

  function _expectInvalidHeight(uint256 height) internal {
    WithdrawRequest memory params = _paramsWithHeight(height);
    bytes memory depository = abi.encodePacked(evmDestinationDepository);
    vm.expectRevert(GatewayVmPayloadBuilder.InvalidMaxBlockHeight.selector);
    buildPayloadOnly(builder, CHAIN_ID, depository, params);
  }
}

contract GatewayVmMaxBlockHeightTest is GatewayVmMaxBlockHeightBase {
  function setUp() public override {
    super.setUp();
    _setConfig(
      builder.getMaxBlockHeightKey(CHAIN_ID),
      bytes32(MAX_BLOCK_HEIGHT)
    );
  }

  function test_acceptsConfiguredCeiling() public view {
    assertEq(_buildEvmPayload().burnIntent.maxBlockHeight, MAX_BLOCK_HEIGHT);
  }

  function test_rejectsUnboundedHeight() public {
    _expectInvalidHeight(type(uint256).max);
  }

  function test_rejectsHeightAboveCeiling() public {
    _expectInvalidHeight(MAX_BLOCK_HEIGHT + 1);
  }

  function test_rejectsZeroHeight() public {
    _expectInvalidHeight(0);
  }

  function test_zeroCeilingDisablesBuilds() public {
    _setConfig(builder.getMaxBlockHeightKey(CHAIN_ID), bytes32(0));
    _expectInvalidHeight(MAX_BLOCK_HEIGHT);
  }

  function test_otherSourceAndDestinationCannotRaiseCeiling() public {
    _setConfig(
      builder.getMaxBlockHeightKey("other-gateway"),
      bytes32(type(uint256).max)
    );
    _setConfig(
      builder.getMaxBlockHeightKey(EVM_SUBCHAIN_ID),
      bytes32(type(uint256).max)
    );
    _expectInvalidHeight(MAX_BLOCK_HEIGHT + 1);
  }

  function test_ownerCanRefreshCeiling() public {
    _setConfig(
      builder.getMaxBlockHeightKey(CHAIN_ID),
      bytes32(MAX_BLOCK_HEIGHT + 100)
    );
    assertEq(
      _buildWithHeight(MAX_BLOCK_HEIGHT + 100).burnIntent.maxBlockHeight,
      MAX_BLOCK_HEIGHT + 100
    );
    _expectInvalidHeight(MAX_BLOCK_HEIGHT + 101);
  }

  function test_relayBlocksDoNotRaiseSourceCeiling() public {
    vm.roll(type(uint64).max);
    vm.warp(block.timestamp + 365 days);
    _expectInvalidHeight(MAX_BLOCK_HEIGHT + 1);
  }

  function testFuzz_preservesAllowedHeight(uint256 height) public view {
    height = bound(height, 1, MAX_BLOCK_HEIGHT);
    assertEq(_buildWithHeight(height).burnIntent.maxBlockHeight, height);
  }

  function testFuzz_rejectsHeightAboveCeiling(uint256 height) public {
    height = bound(height, MAX_BLOCK_HEIGHT + 1, type(uint256).max);
    _expectInvalidHeight(height);
  }
}

contract GatewayVmOptionalMaxBlockHeightTest is GatewayVmMaxBlockHeightBase {
  function test_unsetCeilingAllowsMaximumUintHeight() public view {
    assertEq(
      _buildWithHeight(type(uint256).max).burnIntent.maxBlockHeight,
      type(uint256).max
    );
  }

  function test_unsetCeilingStillRejectsZero() public {
    _expectInvalidHeight(0);
  }

  function test_otherSourceAndDestinationCannotEnableCeiling() public {
    _setConfig(
      builder.getMaxBlockHeightKey("other-gateway"),
      bytes32(uint256(1))
    );
    _setConfig(
      builder.getMaxBlockHeightKey(EVM_SUBCHAIN_ID),
      bytes32(uint256(1))
    );
    assertEq(
      _buildWithHeight(type(uint256).max).burnIntent.maxBlockHeight,
      type(uint256).max
    );
  }

  function testFuzz_unsetCeilingPreservesAnyNonzeroHeight(
    uint256 height
  ) public view {
    height = bound(height, 1, type(uint256).max);
    assertEq(_buildWithHeight(height).burnIntent.maxBlockHeight, height);
  }

  function test_bubblesUnexpectedConfigFailure() public {
    _expectConfigFailure(abi.encodeWithSignature("UnexpectedConfigFailure()"));
  }

  function test_doesNotTreatMissingDifferentKeyAsUnset() public {
    _expectConfigFailure(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        bytes32(uint256(123))
      )
    );
  }

  function _expectConfigFailure(bytes memory reason) internal {
    bytes32 key = builder.getMaxBlockHeightKey(CHAIN_ID);
    vm.mockCallRevert(
      address(config),
      abi.encodeCall(Config.getConfigValue, (key)),
      reason
    );
    WithdrawRequest memory params = _params();
    bytes memory depository = abi.encodePacked(evmDestinationDepository);
    vm.expectRevert(reason);
    buildPayloadOnly(builder, CHAIN_ID, depository, params);
  }
}
