// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  BuildPayloadParams
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  LighterVmPayloadBuilder,
  LighterPayload,
  LighterTransferRequest
} from "../../contracts/payload-builders/LighterVmPayloadBuilder.sol";

abstract contract LighterVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "lighter";
  uint64 internal constant FROM_ACCOUNT_INDEX = 42;
  uint64 internal constant LIGHTER_CHAIN_ID = 304;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  LighterVmPayloadBuilder internal payloadBuilder;

  function setUp() public virtual override {
    super.setUp();

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    payloadBuilder = new LighterVmPayloadBuilder(
      address(config),
      FROM_ACCOUNT_INDEX,
      LIGHTER_CHAIN_ID
    );
  }

  function _setConfig(bytes32 key, bytes32 value) internal {
    vm.prank(owner);
    config.setConfigValue(key, value);
  }

  function _setRouteTypes(
    bytes memory currency,
    uint64 fromRouteType,
    uint64 toRouteType
  ) internal {
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(CHAIN_ID, currency),
      bytes32(uint256(fromRouteType))
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(CHAIN_ID, currency),
      bytes32(uint256(toRouteType))
    );
  }

  function _setAssetIndex(bytes memory currency, uint64 assetIndex) internal {
    _setConfig(
      payloadBuilder.getAssetIndexKey(CHAIN_ID, currency),
      bytes32(uint256(assetIndex))
    );
  }

  function _uint64Bytes(uint64 value) internal pure returns (bytes memory) {
    return abi.encodePacked(value);
  }

  function _transferData(
    uint64 nonce,
    uint64 apiKeyIndex,
    uint64 usdcFee
  ) internal pure returns (bytes memory) {
    return abi.encode(nonce, apiKeyIndex, usdcFee);
  }
}

contract LighterVmPayloadBuilderMetadataTest is LighterVmPayloadBuilderBase {
  function test_curveIsEcdsa() public view {
    assertEq(payloadBuilder.curve(), "Ecdsa");
  }

  function test_familyIsLighterVm() public view {
    assertEq(payloadBuilder.family(), "lighter-vm");
  }

  function test_storesConstructorArgs() public view {
    assertEq(address(payloadBuilder.CONFIG()), address(config));
    assertEq(payloadBuilder.FROM_ACCOUNT_INDEX(), FROM_ACCOUNT_INDEX);
    assertEq(payloadBuilder.LIGHTER_CHAIN_ID(), LIGHTER_CHAIN_ID);
  }
}

contract LighterVmPayloadBuilderConfigTest is LighterVmPayloadBuilderBase {
  function test_configKeysAreCurrencySpecific() public view {
    bytes memory currencyA = _uint64Bytes(3);
    bytes memory currencyB = _uint64Bytes(4);

    assertNotEq(
      payloadBuilder.getFromRouteTypeKey(CHAIN_ID, currencyA),
      payloadBuilder.getFromRouteTypeKey(CHAIN_ID, currencyB)
    );
    assertNotEq(
      payloadBuilder.getToRouteTypeKey(CHAIN_ID, currencyA),
      payloadBuilder.getToRouteTypeKey(CHAIN_ID, currencyB)
    );
    assertNotEq(
      payloadBuilder.getAssetIndexKey(CHAIN_ID, currencyA),
      payloadBuilder.getAssetIndexKey(CHAIN_ID, currencyB)
    );
  }

  function test_readsCurrencyMetadataFromConfig() public {
    bytes memory currency = _uint64Bytes(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    (uint64 fromRouteType, uint64 toRouteType) = payloadBuilder.getRouteTypes(
      CHAIN_ID,
      currency
    );
    assertEq(fromRouteType, 1);
    assertEq(toRouteType, 2);
    assertEq(payloadBuilder.getAssetIndex(CHAIN_ID, currency), 3);
  }
}

contract LighterVmPayloadBuilderTransferTest is LighterVmPayloadBuilderBase {
  function test_buildsTransferPayloadWithCurrencyMetadataFromConfig() public {
    bytes memory currency = _uint64Bytes(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 2_000_000,
      receiver: _uint64Bytes(7),
      nonce: 0,
      data: _transferData(1, 5, 100)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);

    LighterPayload memory decoded = abi.decode(payload, (LighterPayload));
    assertEq(decoded.actionType, 0);

    LighterTransferRequest memory request = abi.decode(
      decoded.parameters,
      (LighterTransferRequest)
    );
    assertEq(request.nonce, 1);
    assertEq(request.fromAccountIndex, FROM_ACCOUNT_INDEX);
    assertEq(request.fromRouteType, 1);
    assertEq(request.apiKeyIndex, 5);
    assertEq(request.toAccountIndex, 7);
    assertEq(request.toRouteType, 2);
    assertEq(request.assetIndex, 3);
    assertEq(request.amount, 2_000_000);
    assertEq(request.usdcFee, 100);
    assertEq(request.lighterChainId, LIGHTER_CHAIN_ID);
    assertEq(request.memo, bytes32(0));
  }

  function test_revertsWhenCurrencyMetadataConfigIsMissing() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _uint64Bytes(3),
      amount: 1,
      receiver: _uint64Bytes(7),
      nonce: 0,
      data: _transferData(1, 5, 100)
    });

    vm.expectRevert();
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }

  function test_revertsWhenAssetIndexConfigIsMissing() public {
    bytes memory currency = _uint64Bytes(99);
    _setRouteTypes(currency, 1, 2);

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 1,
      receiver: _uint64Bytes(7),
      nonce: 0,
      data: _transferData(1, 5, 100)
    });

    vm.expectRevert();
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }

  function test_hashesToSignRejectsUnsupportedActionType() public {
    bytes memory payload = abi.encode(
      LighterPayload({actionType: 1, parameters: ""})
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.UnsupportedActionType.selector,
        uint8(1)
      )
    );
    payloadBuilder.hashesToSign(CHAIN_ID, "", payload);
  }

  function test_buildsExactL1Message() public view {
    LighterTransferRequest memory request = LighterTransferRequest({
      nonce: 1,
      fromAccountIndex: 42,
      fromRouteType: 1,
      apiKeyIndex: 5,
      toAccountIndex: 7,
      toRouteType: 2,
      assetIndex: 3,
      amount: 2_000_000,
      usdcFee: 100,
      lighterChainId: 304,
      memo: bytes32(0)
    });

    string memory expected = string.concat(
      "Transfer\n\n",
      "nonce: 0x0000000000000001\n",
      "from: 0x000000000000002a (route 0x0000000000000001)\n",
      "api key: 0x0000000000000005\n",
      "to: 0x0000000000000007 (route 0x0000000000000002)\n",
      "asset: 0x0000000000000003\n",
      "amount: 0x00000000001e8480\n",
      "fee: 0x0000000000000064\n",
      "chainId: 0x0000000000000130\n",
      "memo: 0000000000000000000000000000000000000000000000000000000000000000\n",
      "Only sign this message for a trusted client!"
    );

    assertEq(payloadBuilder.buildTransferL1Message(request), expected);
  }

  function test_transferHashIsEip191PersonalSign() public {
    bytes memory currency = _uint64Bytes(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 2_000_000,
      receiver: _uint64Bytes(7),
      nonce: 0,
      data: _transferData(1, 5, 100)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    LighterPayload memory decoded = abi.decode(payload, (LighterPayload));
    LighterTransferRequest memory request = abi.decode(
      decoded.parameters,
      (LighterTransferRequest)
    );
    bytes32 expected = MessageHashUtils.toEthSignedMessageHash(
      bytes(payloadBuilder.buildTransferL1Message(request))
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], expected);
  }
}
