// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {Config} from "../../contracts/Config.sol";
import {
  IWithdrawalCounter,
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  HyperliquidVmPayloadBuilder,
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
    allocator = new RelayAllocator(owner, address(hub), address(0xbeef));
    config = new Config(address(allocator));
    payloadBuilder = new HyperliquidVmPayloadBuilder(
      address(config),
      SIGNATURE_CHAIN_ID,
      "Mainnet"
    );

    // Builder tests call buildPayload directly, so this contract stands in for the allocator
    _mockWithdrawalsThisSecond(0);
    _setTargetDecimals(_nativeCurrency(), 8);
  }

  function _mockWithdrawalsThisSecond(uint256 index) internal {
    vm.mockCall(
      address(this),
      abi.encodeWithSelector(IWithdrawalCounter.withdrawalsThisSecond.selector),
      abi.encode(index)
    );
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

  /// @notice Reads the transaction type every payload starts with
  function _txType(bytes memory payload) internal pure returns (uint8) {
    return abi.decode(payload, (uint8));
  }

  /// @notice Decodes a usdSend payload: `(uint8 txType, <UsdSendRequest fields>)`
  function _decodeUsdSend(
    bytes memory payload
  ) internal pure returns (UsdSendRequest memory request) {
    (
      ,
      request.hyperliquidChain,
      request.destination,
      request.amount,
      request.time
    ) = abi.decode(payload, (uint8, string, string, string, uint64));
  }

  /// @notice Decodes a sendAsset payload: `(uint8 txType, <SendAssetRequest fields>)`
  function _decodeSendAsset(
    bytes memory payload
  ) internal pure returns (SendAssetRequest memory request) {
    (
      ,
      request.hyperliquidChain,
      request.destination,
      request.sourceDex,
      request.destinationDex,
      request.token,
      request.amount,
      request.fromSubAccount,
      request.nonce
    ) = abi.decode(
      payload,
      (uint8, string, string, string, string, string, string, string, uint64)
    );
  }

  /// @notice Mirrors `_deriveNonce`: block time in ms plus the caller's withdrawal count
  function _expectedNonce(
    WithdrawRequest memory request
  ) internal view returns (uint64) {
    return
      uint64(block.timestamp * 1000) +
      uint64(
        IWithdrawalCounter(address(this)).withdrawalsThisSecond(request.chainId)
      );
  }
}

contract HyperliquidVmPayloadBuilderBuildPayloadTest is
  HyperliquidVmPayloadBuilderBase
{
  function test_buildsUsdSendPayloadForNativeCurrency() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 123456789,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(1))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    UsdSendRequest memory request = _decodeUsdSend(payload);

    assertEq(_txType(payload), payloadBuilder.USD_SEND_TX_TYPE());
    assertEq(request.hyperliquidChain, "Mainnet");
    assertEq(vm.parseAddress(request.destination), receiverAddr);
    assertEq(request.amount, "1.23456789");
    assertEq(request.time, _expectedNonce(params));

    // The type word is followed directly by the request fields: five head words,
    // then the three string tails, with no envelope or nested tuple offsets
    assertEq(
      payload,
      abi.encode(
        payloadBuilder.USD_SEND_TX_TYPE(),
        request.hyperliquidChain,
        request.destination,
        request.amount,
        request.time
      )
    );
    assertEq(payload.length, 12 * 32);
  }

  function test_buildsSendAssetPayload() public {
    bytes memory currency = hex"11111111111111111111111111111111";
    _setTargetDecimals(currency, 4);
    _setCurrencySymbol(currency, bytes32("HYPE"));
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 25000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE + 456),
      nonce: bytes32(uint256(2))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    SendAssetRequest memory request = _decodeSendAsset(payload);

    assertEq(_txType(payload), payloadBuilder.SEND_ASSET_TX_TYPE());
    assertEq(request.hyperliquidChain, "Mainnet");
    assertEq(vm.parseAddress(request.destination), receiverAddr);
    assertEq(request.sourceDex, "spot");
    assertEq(request.destinationDex, "spot");
    assertEq(request.token, "HYPE:0x11111111111111111111111111111111");
    assertEq(request.amount, "2.5000");
    assertEq(request.fromSubAccount, "");
    assertEq(request.nonce, _expectedNonce(params));

    // The type word is followed directly by the request fields
    assertEq(
      payload,
      abi.encode(
        payloadBuilder.SEND_ASSET_TX_TYPE(),
        request.hyperliquidChain,
        request.destination,
        request.sourceDex,
        request.destinationDex,
        request.token,
        request.amount,
        request.fromSubAccount,
        request.nonce
      )
    );
  }

  function test_buildsSendAssetWithConfiguredDexes() public {
    bytes memory currency = hex"22222222222222222222222222222222";
    _setTargetDecimals(currency, 2);
    _setCurrencySymbol(currency, bytes32("PURR"));
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 150,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(3))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    SendAssetRequest memory request = _decodeSendAsset(payload);

    assertEq(_txType(payload), payloadBuilder.SEND_ASSET_TX_TYPE());
    assertEq(request.sourceDex, "spot");
    assertEq(request.destinationDex, "spot");
    assertEq(request.amount, "1.50");
    assertEq(request.nonce, _expectedNonce(params));
  }

  function test_treatsZeroFilled16ByteCurrencyAsNativeUsdSend() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(1))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    UsdSendRequest memory request = _decodeUsdSend(payload);

    assertEq(_txType(payload), payloadBuilder.USD_SEND_TX_TYPE());
    assertEq(request.amount, "1.00000000");
    assertEq(request.time, _expectedNonce(params));
  }

  function test_capsPastSeedInfluenceToMillisecondComponent() public {
    uint64 legacyNonce = uint64((NOW_SECONDS - 2 days) * 1000 + 123);
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(legacyNonce),
      nonce: bytes32(uint256(1))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    UsdSendRequest memory request = _decodeUsdSend(payload);

    // The seconds come from block time and the seed has no effect
    assertEq(request.time, _expectedNonce(params));
    assertGe(request.time, VALID_NONCE);
    assertLt(request.time, VALID_NONCE + 1000);
  }

  function test_limitsFutureNonceInfluenceToMillisecondComponent() public {
    uint64 legacyNonce = uint64((NOW_SECONDS + 1 days) * 1000 + 999);
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(legacyNonce),
      nonce: bytes32(uint256(1))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    UsdSendRequest memory request = _decodeUsdSend(payload);

    assertEq(request.time, _expectedNonce(params));
    assertGe(request.time, VALID_NONCE);
    assertLt(request.time, VALID_NONCE + 1000);
  }

  function test_oneHundredFutureNonceInputsCannotPoisonLaterSecond() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 100000000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: "",
      nonce: bytes32(uint256(1))
    });
    uint64 highestAttackerNonce;

    for (uint64 i; i < 100; ++i) {
      params.data = abi.encode(uint64((NOW_SECONDS + 1 days) * 1000 + 900 + i));
      bytes memory payload = buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        "",
        params
      );
      UsdSendRequest memory request = _decodeUsdSend(payload);

      if (request.time > highestAttackerNonce) {
        highestAttackerNonce = request.time;
      }
    }

    assertLt(highestAttackerNonce, VALID_NONCE + 1000);

    vm.warp(NOW_SECONDS + 1);
    params.data = abi.encode(uint64((NOW_SECONDS + 1) * 1000));
    bytes memory laterPayload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );
    UsdSendRequest memory laterRequest = _decodeUsdSend(laterPayload);

    assertGt(laterRequest.time, highestAttackerNonce);
  }

  function test_revertsWhenReceiverIsNot20Bytes() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: hex"1234",
      data: abi.encode(uint64(1)),
      nonce: bytes32(uint256(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", params);
  }

  function test_revertsWhenCurrencyIsNot16Bytes() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: hex"1234",
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(uint64(1)),
      nonce: bytes32(uint256(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(2)
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", params);
  }

  function test_revertsWhenTargetDecimalsAreTooLarge() public {
    _setTargetDecimals(
      _nativeCurrency(),
      payloadBuilder.MAX_TARGET_DECIMALS() + 1
    );

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(uint64(1)),
      nonce: bytes32(uint256(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.TargetDecimalsTooLarge.selector,
        uint256(payloadBuilder.MAX_TARGET_DECIMALS() + 1)
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", params);
  }

  function test_revertsWhenTargetDecimalsWouldTruncateIntoRange() public {
    // 262 truncates to 6 as a uint8, which would pass a post-cast bound
    _setConfig(
      payloadBuilder.getTargetDecimalsKey(CHAIN_ID, _nativeCurrency()),
      bytes32(uint256(262))
    );

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(uint64(1)),
      nonce: bytes32(uint256(1))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.TargetDecimalsTooLarge.selector,
        uint256(262)
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }

  function test_revertsWhenCurrencySymbolIsCleared() public {
    _assertRevertsForClearedSymbol(bytes32(0));
  }

  function test_revertsWhenCurrencySymbolIsFlagWord() public {
    _assertRevertsForClearedSymbol(bytes32(uint256(1)));
  }

  function test_revertsWhenCurrencySymbolStartsWithZeroByte() public {
    _assertRevertsForClearedSymbol(bytes32(uint256(NOW_SECONDS)));
  }

  function _assertRevertsForClearedSymbol(bytes32 symbol) internal {
    bytes memory currency = hex"22222222222222222222222222222222";
    _setTargetDecimals(currency, 2);
    _setCurrencySymbol(currency, symbol);
    _setDexes(currency, bytes32("spot"), bytes32("spot"));

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 150,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(3))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.CurrencySymbolNotSet.selector,
        currency
      )
    );
    payloadBuilder.buildPayload(CHAIN_ID, "", params);
  }
}

contract HyperliquidVmPayloadBuilderHashesToSignTest is
  HyperliquidVmPayloadBuilderBase
{
  function test_hashesUsdSendPayloadUsingHyperliquidEip712Domain() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _nativeCurrency(),
      amount: 123456789,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(1))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    UsdSendRequest memory request = _decodeUsdSend(payload);
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

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 25000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _addrBytes(receiverAddr),
      data: abi.encode(VALID_NONCE),
      nonce: bytes32(uint256(1))
    });
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      params
    );

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    SendAssetRequest memory request = _decodeSendAsset(payload);
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
    vm.expectRevert(
      abi.encodeWithSelector(
        HyperliquidVmPayloadBuilder.UnsupportedTransactionType.selector,
        uint8(2)
      )
    );
    payloadBuilder.hashesToSign(CHAIN_ID, "", abi.encode(uint8(2)));
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

/// @notice Hyperliquid has no memo, so the nonce's millisecond is the calling allocator's
/// withdrawal count for the chain in the current second: two withdrawals never share a nonce
contract HyperliquidVmPayloadBuilderWithdrawalCountTest is
  HyperliquidVmPayloadBuilderBase
{
  function _request() internal view returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: "",
        currency: _nativeCurrency(),
        amount: 100000000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: _addrBytes(receiverAddr),
        data: abi.encode(VALID_NONCE),
        nonce: bytes32(uint256(1))
      });
  }

  function _time() internal view returns (uint64) {
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      "",
      _request()
    );
    return _decodeUsdSend(payload).time;
  }

  function test_usesTheCallersWithdrawalCountAsTheMillisecond() public {
    _mockWithdrawalsThisSecond(7);
    assertEq(_time(), VALID_NONCE + 7);

    _mockWithdrawalsThisSecond(999);
    assertEq(_time(), VALID_NONCE + 999);
  }

  function test_revertsOnceTheSecondsNoncesAreUsed() public {
    _mockWithdrawalsThisSecond(1000);
    vm.expectRevert(HyperliquidVmPayloadBuilder.NoncesExhausted.selector);
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", _request());
  }

  function test_revertsWhenTheCallerKeepsNoWithdrawalCount() public {
    vm.clearMockedCalls();
    vm.expectRevert();
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", _request());
  }
}
