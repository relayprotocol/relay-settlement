// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  BuildPayloadParams
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  HyperliquidVmPayloadBuilder,
  HyperliquidPayload,
  UsdSendRequest,
  SendAssetRequest
} from "../../contracts/payload-builders/HyperliquidVmPayloadBuilder.sol";

abstract contract HyperliquidVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "hyperliquid";
  uint256 internal constant SIGNATURE_CHAIN_ID = 42161;
  uint256 internal constant NOW_SECONDS = 1_700_000_000;
  uint64 internal constant VALID_NONCE = 1_700_000_000_000;

  address internal receiverAddr;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  HyperliquidVmPayloadBuilder internal payloadBuilder;

  function setUp() public virtual override {
    super.setUp();
    vm.warp(NOW_SECONDS);
    receiverAddr = otherAccounts[0];

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    payloadBuilder = new HyperliquidVmPayloadBuilder(
      address(config),
      SIGNATURE_CHAIN_ID,
      "Mainnet"
    );

    _setTargetDecimals(_nativeCurrency(), 8);
  }

  function _nativeCurrency() internal pure returns (bytes memory) {
    return hex"00000000000000000000000000000000";
  }

  function _setConfig(bytes32 key, bytes32 value) internal {
    vm.prank(owner);
    config.setConfigValue(key, value);
  }

  function _setTargetDecimals(bytes memory currency, uint8 decimals) internal {
    _setConfig(
      payloadBuilder.getTargetDecimalsKey(CHAIN_ID, currency),
      bytes32(uint256(decimals))
    );
  }

  function _setCurrencySymbol(bytes memory currency, bytes32 symbol) internal {
    _setConfig(payloadBuilder.getCurrencySymbolKey(CHAIN_ID, currency), symbol);
  }

  function _setDexes(
    bytes memory currency,
    bytes32 sourceDex,
    bytes32 destinationDex
  ) internal {
    _setConfig(payloadBuilder.getSourceDexKey(CHAIN_ID, currency), sourceDex);
    _setConfig(
      payloadBuilder.getDestinationDexKey(CHAIN_ID, currency),
      destinationDex
    );
  }

  function _addrBytes(address a) internal pure returns (bytes memory) {
    return abi.encodePacked(a);
  }
}

contract HyperliquidVmPayloadBuilderBuildPayloadTest is
  HyperliquidVmPayloadBuilderBase
{
  function test_buildsUsdSendPayloadForNativeCurrency() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 123456789,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(VALID_NONCE)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory request = abi.decode(
      decoded.parameters,
      (UsdSendRequest)
    );

    assertEq(decoded.txType, payloadBuilder.USD_SEND_TX_TYPE());
    assertEq(request.hyperliquidChain, "Mainnet");
    assertEq(vm.parseAddress(request.destination), receiverAddr);
    assertEq(request.amount, "1.23456789");
    assertEq(request.time, VALID_NONCE);
  }

  function test_buildsSendAssetPayload() public {
    bytes memory currency = hex"11111111111111111111111111111111";
    _setTargetDecimals(currency, 4);
    _setCurrencySymbol(currency, bytes32("HYPE"));
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 25000,
      receiver: _addrBytes(receiverAddr),
      nonce: 2,
      data: abi.encode(VALID_NONCE + 456)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    SendAssetRequest memory request = abi.decode(
      decoded.parameters,
      (SendAssetRequest)
    );

    assertEq(decoded.txType, payloadBuilder.SEND_ASSET_TX_TYPE());
    assertEq(request.hyperliquidChain, "Mainnet");
    assertEq(vm.parseAddress(request.destination), receiverAddr);
    assertEq(request.sourceDex, "spot");
    assertEq(request.destinationDex, "spot");
    assertEq(request.token, "HYPE:0x11111111111111111111111111111111");
    assertEq(request.amount, "2.5000");
    assertEq(request.fromSubAccount, "");
    assertEq(request.nonce, VALID_NONCE + 456);
  }

  function test_buildsSendAssetWithConfiguredDexes() public {
    bytes memory currency = hex"22222222222222222222222222222222";
    _setTargetDecimals(currency, 2);
    _setCurrencySymbol(currency, bytes32("PURR"));
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 150,
      receiver: _addrBytes(receiverAddr),
      nonce: 3,
      data: abi.encode(VALID_NONCE)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    SendAssetRequest memory request = abi.decode(
      decoded.parameters,
      (SendAssetRequest)
    );

    assertEq(decoded.txType, payloadBuilder.SEND_ASSET_TX_TYPE());
    assertEq(request.sourceDex, "spot");
    assertEq(request.destinationDex, "spot");
    assertEq(request.amount, "1.50");
    assertEq(request.nonce, VALID_NONCE);
  }

  function test_treatsZeroFilled16ByteCurrencyAsNativeUsdSend() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 100000000,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(VALID_NONCE)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory request = abi.decode(
      decoded.parameters,
      (UsdSendRequest)
    );

    assertEq(decoded.txType, payloadBuilder.USD_SEND_TX_TYPE());
    assertEq(request.amount, "1.00000000");
    assertEq(request.time, VALID_NONCE);
  }

  function test_usesMillisecondComponentFromLegacyPastNonce() public {
    uint64 legacyNonce = uint64((NOW_SECONDS - 2 days) * 1000 + 123);
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 100000000,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(legacyNonce)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory request = abi.decode(
      decoded.parameters,
      (UsdSendRequest)
    );

    assertEq(request.time, VALID_NONCE + 123);
  }

  function test_limitsFutureNonceInfluenceToMillisecondComponent() public {
    uint64 legacyNonce = uint64((NOW_SECONDS + 1 days) * 1000 + 999);
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 100000000,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(legacyNonce)
    });

    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory request = abi.decode(
      decoded.parameters,
      (UsdSendRequest)
    );

    assertEq(request.time, VALID_NONCE + 999);
  }

  function test_oneHundredFutureNonceInputsCannotPoisonLaterSecond() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 100000000,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });
    uint64 highestAttackerNonce;

    for (uint64 i; i < 100; ++i) {
      params.data = abi.encode(uint64((NOW_SECONDS + 1 days) * 1000 + 900 + i));
      bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);
      HyperliquidPayload memory decoded = abi.decode(
        payload,
        (HyperliquidPayload)
      );
      UsdSendRequest memory request = abi.decode(
        decoded.parameters,
        (UsdSendRequest)
      );

      highestAttackerNonce = request.time;
    }

    assertEq(highestAttackerNonce, VALID_NONCE + 999);

    vm.warp(NOW_SECONDS + 1);
    params.data = abi.encode(uint64((NOW_SECONDS + 1) * 1000));
    bytes memory laterPayload = payloadBuilder.buildPayload(
      CHAIN_ID,
      "",
      params
    );
    HyperliquidPayload memory laterDecoded = abi.decode(
      laterPayload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory laterRequest = abi.decode(
      laterDecoded.parameters,
      (UsdSendRequest)
    );

    assertGt(laterRequest.time, highestAttackerNonce);
  }

  function test_revertsWhenReceiverIsNot20Bytes() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 1,
      receiver: hex"1234",
      nonce: 1,
      data: abi.encode(uint64(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }

  function test_revertsWhenCurrencyIsNot16Bytes() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: hex"1234",
      amount: 1,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(uint64(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }

  function test_revertsWhenTargetDecimalsAreTooLarge() public {
    _setTargetDecimals(
      _nativeCurrency(),
      payloadBuilder.MAX_TARGET_DECIMALS() + 1
    );

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 1,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(uint64(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.TargetDecimalsTooLarge.selector,
        uint256(payloadBuilder.MAX_TARGET_DECIMALS() + 1)
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }
}

contract HyperliquidVmPayloadBuilderHashesToSignTest is
  HyperliquidVmPayloadBuilderBase
{
  function test_hashesUsdSendPayloadUsingHyperliquidEip712Domain() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _nativeCurrency(),
      amount: 123456789,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(VALID_NONCE)
    });
    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    UsdSendRequest memory request = abi.decode(
      decoded.parameters,
      (UsdSendRequest)
    );
    bytes32 structHash = keccak256(
      abi.encode(
        payloadBuilder.USD_SEND_TYPEHASH(),
        keccak256(bytes(request.hyperliquidChain)),
        keccak256(bytes(request.destination)),
        keccak256(bytes(request.amount)),
        request.time
      )
    );
    bytes32 domainSep = Eip712.domainSeparator(
      "HyperliquidSignTransaction",
      "1",
      SIGNATURE_CHAIN_ID,
      address(0)
    );
    bytes32 expected = keccak256(
      abi.encodePacked("\x19\x01", domainSep, structHash)
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], expected);
  }

  function test_hashesSendAssetPayloadUsingHyperliquidEip712Domain() public {
    bytes memory currency = hex"11111111111111111111111111111111";
    _setTargetDecimals(currency, 4);
    _setCurrencySymbol(currency, bytes32("HYPE"));
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: currency,
      amount: 25000,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: abi.encode(VALID_NONCE)
    });
    bytes memory payload = payloadBuilder.buildPayload(CHAIN_ID, "", params);

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    HyperliquidPayload memory decoded = abi.decode(
      payload,
      (HyperliquidPayload)
    );
    SendAssetRequest memory request = abi.decode(
      decoded.parameters,
      (SendAssetRequest)
    );
    bytes32 structHash = keccak256(
      abi.encode(
        payloadBuilder.SEND_ASSET_TYPEHASH(),
        keccak256(bytes(request.hyperliquidChain)),
        keccak256(bytes(request.destination)),
        keccak256(bytes(request.sourceDex)),
        keccak256(bytes(request.destinationDex)),
        keccak256(bytes(request.token)),
        keccak256(bytes(request.amount)),
        keccak256(bytes(request.fromSubAccount)),
        request.nonce
      )
    );
    bytes32 domainSep = Eip712.domainSeparator(
      "HyperliquidSignTransaction",
      "1",
      SIGNATURE_CHAIN_ID,
      address(0)
    );
    bytes32 expected = keccak256(
      abi.encodePacked("\x19\x01", domainSep, structHash)
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], expected);
  }

  function test_revertsForUnsupportedTransactionType() public {
    HyperliquidPayload memory decoded = HyperliquidPayload({
      txType: 2,
      parameters: ""
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.UnsupportedTransactionType.selector,
        uint8(2)
      )
    );
    payloadBuilder.hashesToSign(CHAIN_ID, "", abi.encode(decoded));
  }

  function test_namespacesConfigKeys() public view {
    assertEq(
      payloadBuilder.getTargetDecimalsKey(CHAIN_ID, _nativeCurrency()),
      keccak256(
        abi.encodePacked(
          keccak256("HYPERLIQUID_VM_TARGET_DECIMALS"),
          CHAIN_ID,
          _nativeCurrency()
        )
      )
    );
    assertEq(
      payloadBuilder.getCurrencySymbolKey(CHAIN_ID, _nativeCurrency()),
      keccak256(
        abi.encodePacked(
          keccak256("HYPERLIQUID_VM_CURRENCY_SYMBOL"),
          CHAIN_ID,
          _nativeCurrency()
        )
      )
    );
    assertEq(
      payloadBuilder.getSourceDexKey(CHAIN_ID, _nativeCurrency()),
      keccak256(
        abi.encodePacked(
          keccak256("HYPERLIQUID_VM_SOURCE_DEX"),
          CHAIN_ID,
          _nativeCurrency()
        )
      )
    );
    assertEq(
      payloadBuilder.getDestinationDexKey(CHAIN_ID, _nativeCurrency()),
      keccak256(
        abi.encodePacked(
          keccak256("HYPERLIQUID_VM_DESTINATION_DEX"),
          CHAIN_ID,
          _nativeCurrency()
        )
      )
    );
  }
}

contract HyperliquidVmPayloadBuilderMetadataTest is
  HyperliquidVmPayloadBuilderBase
{
  function test_storesConstructorArgs() public view {
    assertEq(payloadBuilder.SIGNATURE_CHAIN_ID(), SIGNATURE_CHAIN_ID);
    assertEq(payloadBuilder.hyperliquidChain(), "Mainnet");
  }

  function test_returnsExpectedCurve() public view {
    assertEq(payloadBuilder.curve(), "Ecdsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(payloadBuilder.family(), "hyperliquid-vm");
  }
}
