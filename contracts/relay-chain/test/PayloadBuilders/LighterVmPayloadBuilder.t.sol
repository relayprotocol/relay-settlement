// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {Utils} from "../../contracts/Utils.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  LighterVmPayloadBuilder,
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
    allocator = new RelayAllocator(owner, address(hub), address(0xbeef));
    config = new Config(address(allocator));
    payloadBuilder = new LighterVmPayloadBuilder(address(config));
    _setInstance(CHAIN_ID, FROM_ACCOUNT_INDEX, LIGHTER_CHAIN_ID);
  }

  function _setConfig(bytes32 key, bytes32 value) internal {
    vm.prank(owner);
    config.setConfigValue(key, value);
  }

  function _setInstance(
    string memory chainId,
    uint64 fromAccountIndex,
    uint64 lighterChainId
  ) internal {
    _setConfig(
      payloadBuilder.getFromAccountIndexKey(chainId),
      bytes32(uint256(fromAccountIndex))
    );
    _setConfig(
      payloadBuilder.getLighterChainIdKey(chainId),
      bytes32(uint256(lighterChainId))
    );
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

  /// @notice SDK lighter-vm encoding of the configured depository account index
  function _depository() internal pure returns (bytes memory) {
    return _uint64Bytes(FROM_ACCOUNT_INDEX);
  }

  function _uint64Bytes(uint64 value) internal pure returns (bytes memory) {
    return abi.encodePacked(value);
  }

  /// @notice SDK lighter-vm 16-byte currency encoding
  function _currency(uint64 value) internal pure returns (bytes memory) {
    return abi.encodePacked(uint128(value));
  }

  function _withdrawRequest(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: chainId,
        depository: "",
        currency: currency,
        amount: 2_000_000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: _uint64Bytes(7),
        data: _transferData(1, 5, 100),
        nonce: bytes32(uint256(0))
      });
  }

  /// @notice Decodes a Transfer payload: `(uint8 actionType, LighterTransferRequest)`
  function _decodeTransfer(
    bytes memory payload
  ) internal pure returns (LighterTransferRequest memory request) {
    (, request) = abi.decode(payload, (uint8, LighterTransferRequest));
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

  function test_storesConfig() public view {
    assertEq(address(payloadBuilder.CONFIG()), address(config));
  }

  function test_readsInstanceValuesFromConfig() public view {
    assertEq(payloadBuilder.getFromAccountIndex(CHAIN_ID), FROM_ACCOUNT_INDEX);
    assertEq(payloadBuilder.getLighterChainId(CHAIN_ID), LIGHTER_CHAIN_ID);
  }
}

contract LighterVmPayloadBuilderConfigTest is LighterVmPayloadBuilderBase {
  function test_configKeysAreCurrencySpecific() public view {
    bytes memory currencyA = _currency(3);
    bytes memory currencyB = _currency(4);

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
    bytes memory currency = _currency(99);
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
    bytes memory currency = _currency(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 2_000_000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(7),
      data: _transferData(1, 5, 100),
      nonce: bytes32(uint256(0))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      params
    );

    // The action type word is followed inline by the static transfer request
    assertEq(payload.length, 12 * 32);
    assertEq(abi.decode(payload, (uint8)), 0);

    LighterTransferRequest memory request = _decodeTransfer(payload);
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
    assertEq(
      request.memo,
      keccak256(abi.encode(address(payloadBuilder), params))
    );
  }

  function test_revertsWhenCurrencyMetadataConfigIsMissing() public {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: _currency(3),
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(7),
      data: _transferData(1, 5, 100),
      nonce: bytes32(uint256(0))
    });

    vm.expectRevert();
    buildPayloadOnly(payloadBuilder, CHAIN_ID, _depository(), params);
  }

  function test_revertsWhenAssetIndexConfigIsMissing() public {
    bytes memory currency = _currency(99);
    _setRouteTypes(currency, 1, 2);

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 1,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(7),
      data: _transferData(1, 5, 100),
      nonce: bytes32(uint256(0))
    });

    vm.expectRevert();
    buildPayloadOnly(payloadBuilder, CHAIN_ID, _depository(), params);
  }

  function test_hashesToSignRejectsUnsupportedActionType() public {
    bytes memory payload = abi.encode(uint8(1));

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
    bytes memory currency = _currency(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: "",
      currency: currency,
      amount: 2_000_000,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(7),
      data: _transferData(1, 5, 100),
      nonce: bytes32(uint256(0))
    });

    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      params
    );
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    LighterTransferRequest memory request = _decodeTransfer(payload);
    bytes32 expected = MessageHashUtils.toEthSignedMessageHash(
      bytes(payloadBuilder.buildTransferL1Message(request))
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], expected);
  }
}

contract LighterVmPayloadBuilderCurrencyHardeningTest is
  LighterVmPayloadBuilderBase
{
  function test_revertsOnNonCanonicalCurrencyLength() public {
    bytes memory currency = _uint64Bytes(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(8)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depository(),
      _withdrawRequest(CHAIN_ID, currency)
    );
  }

  function test_currencyKeysDoNotAliasAcrossChainIdBoundary() public view {
    bytes memory currency = _currency(3);
    bytes memory shifted = bytes.concat("-testnet", currency);

    assertNotEq(
      payloadBuilder.getFromRouteTypeKey(CHAIN_ID, shifted),
      payloadBuilder.getFromRouteTypeKey("lighter-testnet", currency)
    );
    assertNotEq(
      payloadBuilder.getToRouteTypeKey(CHAIN_ID, shifted),
      payloadBuilder.getToRouteTypeKey("lighter-testnet", currency)
    );
    assertNotEq(
      payloadBuilder.getAssetIndexKey(CHAIN_ID, shifted),
      payloadBuilder.getAssetIndexKey("lighter-testnet", currency)
    );
  }

  function test_boundaryShiftedCurrencyDoesNotResolveOtherChainConfig() public {
    string memory otherChain = "lighter-testnet";
    bytes memory otherCurrency = _uint64Bytes(3);
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(otherChain, otherCurrency),
      bytes32(uint256(1))
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(otherChain, otherCurrency),
      bytes32(uint256(1))
    );
    _setConfig(
      payloadBuilder.getAssetIndexKey(otherChain, otherCurrency),
      bytes32(uint256(3))
    );

    // 16 bytes, so only the key derivation separates the two chains
    bytes memory shifted = bytes.concat("-testnet", otherCurrency);
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getFromRouteTypeKey(CHAIN_ID, shifted)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depository(),
      _withdrawRequest(CHAIN_ID, shifted)
    );
  }

  function test_revertsWhenCurrencyDisabledByZeroAssetIndex() public {
    bytes memory currency = _currency(99);
    _setRouteTypes(currency, 0, 0);
    _setAssetIndex(currency, 3);
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depository(),
      _withdrawRequest(CHAIN_ID, currency)
    );

    _setAssetIndex(currency, 0);

    bytes memory expected = abi.encodeWithSelector(
      LighterVmPayloadBuilder.CurrencyDisabled.selector,
      CHAIN_ID,
      currency
    );
    vm.expectRevert(expected);
    payloadBuilder.getAssetIndex(CHAIN_ID, currency);
    vm.expectRevert(expected);
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _depository(),
      _withdrawRequest(CHAIN_ID, currency)
    );
  }
}

contract LighterRequestIdentityTest is LighterVmPayloadBuilderBase {
  function test_distinctRelayRequestsHaveDistinctSignedMessages() public {
    bytes memory depository = _uint64Bytes(FROM_ACCOUNT_INDEX);
    bytes memory currency = _currency(3);
    _setAssetIndex(currency, 3);
    _setRouteTypes(currency, 0, 0);
    vm.startPrank(owner);
    allocator.setPayloadBuilder(CHAIN_ID, depository, address(payloadBuilder));
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    vm.stopPrank();
    WithdrawRequest memory request = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: depository,
      currency: currency,
      amount: 10,
      spenderChainId: "ethereum-mainnet",
      spender: abi.encodePacked(owner),
      receiver: _uint64Bytes(100),
      data: _transferData(7, 4, 0),
      nonce: bytes32(uint256(1))
    });
    vm.startPrank(owner);
    hub.mint(
      Utils.generateAddress(request.spenderChainId, request.spender),
      Utils.generateTokenId(CHAIN_ID, currency),
      30
    );
    vm.stopPrank();
    vm.prank(owner);
    bytes32 first = allocator.submitWithdrawRequest(request);
    request.nonce = bytes32(uint256(2));
    vm.prank(owner);
    bytes32 second = allocator.submitWithdrawRequest(request);
    assertNotEq(
      allocator.hashesToSign(first, 0),
      allocator.hashesToSign(second, 0)
    );
    LighterTransferRequest memory transfer = _decodeTransfer(
      allocator.payloads(second)
    );
    assertNotEq(transfer.memo, bytes32(0));
    assertEq(transfer.nonce, 7);
  }

  function test_hashesBuilderInputsUsingBitcoinDomain() public {
    bytes memory currency = _currency(3);
    _setAssetIndex(currency, 3);
    _setRouteTypes(currency, 0, 0);
    bytes memory depository = _uint64Bytes(FROM_ACCOUNT_INDEX);
    WithdrawRequest memory params = WithdrawRequest({
      chainId: CHAIN_ID,
      depository: depository,
      currency: currency,
      amount: 10,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(100),
      data: _transferData(7, 4, 0),
      nonce: bytes32(uint256(123))
    });
    bytes memory first = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      depository,
      params
    );
    LighterTransferRequest memory transfer = _decodeTransfer(first);
    assertEq(
      transfer.memo,
      keccak256(abi.encode(address(payloadBuilder), params))
    );
    assertEq(transfer.nonce, 7);
    assertEq(
      first,
      buildPayloadOnly(payloadBuilder, CHAIN_ID, depository, params)
    );

    // A different Relay nonce must change the signed message even with the same native nonce.
    params.nonce = bytes32(uint256(params.nonce) + 1);
    bytes memory second = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      depository,
      params
    );
    assertNotEq(
      payloadBuilder.hashesToSign(CHAIN_ID, depository, first)[0],
      payloadBuilder.hashesToSign(CHAIN_ID, depository, second)[0]
    );
  }

  function test_bindsDepositoryChainAndBuilderIntoSignedMessage() public {
    bytes memory currency = _currency(3);
    _setAssetIndex(currency, 3);
    _setRouteTypes(currency, 0, 0);
    bytes memory depository = _uint64Bytes(FROM_ACCOUNT_INDEX);
    bytes32 firstHash = _signedHash(
      payloadBuilder,
      CHAIN_ID,
      depository,
      currency
    );

    // A second depository under the same chain needs its own account index;
    // routing it at this builder without one reverts (see DepositoryMismatch tests).
    string memory otherDepositoryChain = "lighter-other-depository";
    _setInstance(
      otherDepositoryChain,
      FROM_ACCOUNT_INDEX + 1,
      LIGHTER_CHAIN_ID
    );
    _setConfig(
      payloadBuilder.getAssetIndexKey(otherDepositoryChain, currency),
      bytes32(uint256(3))
    );
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(otherDepositoryChain, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(otherDepositoryChain, currency),
      bytes32(0)
    );
    assertNotEq(
      firstHash,
      _signedHash(
        payloadBuilder,
        otherDepositoryChain,
        _uint64Bytes(FROM_ACCOUNT_INDEX + 1),
        currency
      )
    );

    string memory otherChain = "lighter-other";
    _setInstance(otherChain, FROM_ACCOUNT_INDEX, LIGHTER_CHAIN_ID);
    _setConfig(
      payloadBuilder.getAssetIndexKey(otherChain, currency),
      bytes32(uint256(3))
    );
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(otherChain, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(otherChain, currency),
      bytes32(0)
    );
    assertNotEq(
      firstHash,
      _signedHash(payloadBuilder, otherChain, depository, currency)
    );

    assertNotEq(
      firstHash,
      _signedHash(
        new LighterVmPayloadBuilder(address(config)),
        CHAIN_ID,
        depository,
        currency
      )
    );
  }

  /// @notice Hash the allocator signs for a request routed at `chainId`/`depository`
  function _signedHash(
    LighterVmPayloadBuilder builder,
    string memory chainId,
    bytes memory depository,
    bytes memory currency
  ) internal view returns (bytes32) {
    WithdrawRequest memory params = WithdrawRequest({
      chainId: chainId,
      depository: depository,
      currency: currency,
      amount: 10,
      spenderChainId: "relay",
      spender: abi.encodePacked(address(1)),
      receiver: _uint64Bytes(100),
      data: _transferData(7, 4, 0),
      nonce: bytes32(uint256(123))
    });
    return
      builder.hashesToSign(
        chainId,
        depository,
        buildPayloadOnly(builder, chainId, depository, params)
      )[0];
  }
}

contract LighterVmPayloadBuilderMaxUsdcFeeTest is LighterVmPayloadBuilderBase {
  bytes internal currency = _currency(99);

  function setUp() public override {
    super.setUp();
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);
  }

  function _setMaxUsdcFee(uint64 maxUsdcFee) internal {
    _setConfig(
      payloadBuilder.getMaxUsdcFeeKey(CHAIN_ID),
      bytes32(uint256(maxUsdcFee))
    );
  }

  function _paramsWithFee(
    uint256 amount,
    uint64 usdcFee
  ) internal view returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: "",
        currency: currency,
        amount: amount,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: _uint64Bytes(7),
        data: _transferData(1, 5, usdcFee),
        nonce: bytes32(uint256(0))
      });
  }

  function _builtFee(
    WithdrawRequest memory params
  ) internal view returns (uint64) {
    bytes memory payload = buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      params
    );
    LighterTransferRequest memory request = _decodeTransfer(payload);
    return request.usdcFee;
  }

  function _expectFeeExceedsMaxFee(uint64 fee, uint64 maxFee) internal {
    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.FeeExceedsMaxFee.selector,
        fee,
        maxFee
      )
    );
  }

  function test_defaultMaxUsdcFeeAppliesWhenConfigIsUnset() public view {
    assertEq(payloadBuilder.DEFAULT_MAX_USDC_FEE(), 3_000_000);
    assertEq(
      payloadBuilder.getMaxUsdcFee(CHAIN_ID),
      payloadBuilder.DEFAULT_MAX_USDC_FEE()
    );
  }

  function test_maxUsdcFeeKeyIsChainSpecific() public view {
    assertNotEq(
      payloadBuilder.getMaxUsdcFeeKey(CHAIN_ID),
      payloadBuilder.getMaxUsdcFeeKey("lighter-2")
    );
  }

  function test_allowsFeeAtDefaultMaxUsdcFee() public {
    uint64 maxFee = payloadBuilder.DEFAULT_MAX_USDC_FEE();
    assertEq(_builtFee(_paramsWithFee(2_000_000, maxFee)), maxFee);
  }

  function test_rejectsFeeAboveDefaultMaxUsdcFee() public {
    uint64 maxFee = payloadBuilder.DEFAULT_MAX_USDC_FEE();
    _expectFeeExceedsMaxFee(maxFee + 1, maxFee);
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      _paramsWithFee(1, maxFee + 1)
    );
  }

  /// @notice A one-unit withdrawal may not carry a fee at Lighter's public
  ///         `MaxTransferAmount` (2^60 - 1) against the shared depository account.
  function test_rejectsFeeAtLighterMaxTransferAmount() public {
    uint64 hugeFee = uint64((uint256(1) << 60) - 1);
    _expectFeeExceedsMaxFee(hugeFee, payloadBuilder.DEFAULT_MAX_USDC_FEE());
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      _paramsWithFee(1, hugeFee)
    );
  }

  function test_configOverrideLowersMaxUsdcFee() public {
    _setMaxUsdcFee(5);
    assertEq(payloadBuilder.getMaxUsdcFee(CHAIN_ID), 5);
    assertEq(_builtFee(_paramsWithFee(1, 5)), 5);

    _expectFeeExceedsMaxFee(6, 5);
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      _paramsWithFee(1, 6)
    );
  }

  function test_configOverrideRaisesMaxUsdcFee() public {
    uint64 aboveDefault = payloadBuilder.DEFAULT_MAX_USDC_FEE() + 1;
    _setMaxUsdcFee(aboveDefault);
    assertEq(_builtFee(_paramsWithFee(1, aboveDefault)), aboveDefault);
  }

  function test_zeroConfigOverrideAdmitsOnlyFeeFreeTransfers() public {
    _setMaxUsdcFee(0);
    assertEq(_builtFee(_paramsWithFee(1, 0)), 0);

    _expectFeeExceedsMaxFee(1, 0);
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      _depository(),
      _paramsWithFee(1, 1)
    );
  }

  /// @notice The bound applies at build time only: a payload already stored by
  ///         the allocator with a larger fee still hashes as before.
  function test_hashesToSignStillCoversStoredPayloadAboveMaxUsdcFee()
    public
    view
  {
    LighterTransferRequest memory request = LighterTransferRequest({
      nonce: 1,
      fromAccountIndex: FROM_ACCOUNT_INDEX,
      fromRouteType: 1,
      apiKeyIndex: 5,
      toAccountIndex: 7,
      toRouteType: 2,
      assetIndex: 3,
      amount: 1,
      usdcFee: uint64((uint256(1) << 60) - 1),
      lighterChainId: LIGHTER_CHAIN_ID,
      memo: bytes32(0)
    });
    bytes memory payload = abi.encode(uint8(0), request);

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      payload
    );

    assertEq(hashes.length, 1);
    assertEq(
      hashes[0],
      MessageHashUtils.toEthSignedMessageHash(
        bytes(payloadBuilder.buildTransferL1Message(request))
      )
    );
  }
}

/// @notice The transfer memo commits to the whole withdraw request, so the signed L1
/// message (and the withdrawal id derived from it) is unique per request
contract LighterVmPayloadBuilderRequestHashTest is LighterVmPayloadBuilderBase {
  function _payload(address spender) internal returns (bytes memory) {
    bytes memory currency = _currency(99);
    _setRouteTypes(currency, 1, 2);
    _setAssetIndex(currency, 3);

    return
      buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        _depository(),
        WithdrawRequest({
          chainId: CHAIN_ID,
          depository: "",
          currency: currency,
          amount: 2_000_000,
          spenderChainId: "relay",
          spender: abi.encodePacked(spender),
          receiver: _uint64Bytes(7),
          data: _transferData(1, 5, 100),
          nonce: bytes32(uint256(0))
        })
      );
  }

  function _memo(bytes memory payload) internal pure returns (bytes32) {
    LighterTransferRequest memory request = _decodeTransfer(payload);
    return request.memo;
  }

  function test_memoDiffersPerRequest() public {
    assertTrue(_memo(_payload(address(1))) != _memo(_payload(address(2))));
  }

  function test_hashesToSignDifferPerRequest() public {
    bytes32[] memory first = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      _payload(address(1))
    );
    bytes32[] memory second = payloadBuilder.hashesToSign(
      CHAIN_ID,
      "",
      _payload(address(2))
    );
    assertTrue(first[0] != second[0]);
  }
}

/// @notice One builder serves several Lighter instances, each with its own
///         depository account index and Lighter app-chain id from Config
contract LighterVmPayloadBuilderMultiInstanceTest is
  LighterVmPayloadBuilderBase
{
  string internal constant OTHER_CHAIN_ID = "robinhood-lighter";
  uint64 internal constant OTHER_FROM_ACCOUNT_INDEX = 28482;
  uint64 internal constant OTHER_LIGHTER_CHAIN_ID = 466324;

  bytes internal currency = _currency(0);

  function setUp() public override {
    super.setUp();
    _setInstance(
      OTHER_CHAIN_ID,
      OTHER_FROM_ACCOUNT_INDEX,
      OTHER_LIGHTER_CHAIN_ID
    );
    _setRouteTypes(currency, 0, 0);
    _setAssetIndex(currency, 3);
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(OTHER_CHAIN_ID, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(OTHER_CHAIN_ID, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getAssetIndexKey(OTHER_CHAIN_ID, currency),
      bytes32(uint256(3))
    );
  }

  function _params(
    string memory chainId,
    uint64 depository
  ) internal view returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: chainId,
        depository: _uint64Bytes(depository),
        currency: currency,
        amount: 2_000_000,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: _uint64Bytes(7),
        data: _transferData(1, 5, 100),
        nonce: bytes32(uint256(0))
      });
  }

  function _transfer(
    bytes memory payload
  ) internal pure returns (LighterTransferRequest memory) {
    return _decodeTransfer(payload);
  }

  function _build(
    string memory chainId,
    uint64 depository
  ) internal view returns (bytes memory) {
    WithdrawRequest memory params = _params(chainId, depository);
    return buildPayloadOnly(payloadBuilder, chainId, params.depository, params);
  }

  function test_instanceKeysAreChainSpecific() public view {
    assertNotEq(
      payloadBuilder.getFromAccountIndexKey(CHAIN_ID),
      payloadBuilder.getFromAccountIndexKey(OTHER_CHAIN_ID)
    );
    assertNotEq(
      payloadBuilder.getLighterChainIdKey(CHAIN_ID),
      payloadBuilder.getLighterChainIdKey(OTHER_CHAIN_ID)
    );
    assertNotEq(
      payloadBuilder.getFromAccountIndexKey(CHAIN_ID),
      payloadBuilder.getLighterChainIdKey(CHAIN_ID)
    );
  }

  function test_buildsEachInstanceWithItsConfiguredValues() public view {
    LighterTransferRequest memory first = _transfer(
      _build(CHAIN_ID, FROM_ACCOUNT_INDEX)
    );
    assertEq(first.fromAccountIndex, FROM_ACCOUNT_INDEX);
    assertEq(first.lighterChainId, LIGHTER_CHAIN_ID);

    LighterTransferRequest memory second = _transfer(
      _build(OTHER_CHAIN_ID, OTHER_FROM_ACCOUNT_INDEX)
    );
    assertEq(second.fromAccountIndex, OTHER_FROM_ACCOUNT_INDEX);
    assertEq(second.lighterChainId, OTHER_LIGHTER_CHAIN_ID);

    // Everything else in the transfer is unchanged across instances.
    assertEq(second.nonce, first.nonce);
    assertEq(second.apiKeyIndex, first.apiKeyIndex);
    assertEq(second.toAccountIndex, first.toAccountIndex);
    assertEq(second.assetIndex, first.assetIndex);
    assertEq(second.amount, first.amount);
    assertEq(second.usdcFee, first.usdcFee);
  }

  function test_signsExactL1MessagePerInstance() public view {
    bytes memory payload = _build(OTHER_CHAIN_ID, OTHER_FROM_ACCOUNT_INDEX);
    LighterTransferRequest memory request = _transfer(payload);

    string memory expected = string.concat(
      "Transfer\n\n",
      "nonce: 0x0000000000000001\n",
      "from: 0x0000000000006f42 (route 0x0000000000000000)\n",
      "api key: 0x0000000000000005\n",
      "to: 0x0000000000000007 (route 0x0000000000000000)\n",
      "asset: 0x0000000000000003\n",
      "amount: 0x00000000001e8480\n",
      "fee: 0x0000000000000064\n",
      "chainId: 0x0000000000071d94\n",
      "memo: ",
      _hex64(request.memo),
      "\n",
      "Only sign this message for a trusted client!"
    );

    assertEq(payloadBuilder.buildTransferL1Message(request), expected);
    assertEq(
      payloadBuilder.hashesToSign(
        OTHER_CHAIN_ID,
        _uint64Bytes(OTHER_FROM_ACCOUNT_INDEX),
        payload
      )[0],
      MessageHashUtils.toEthSignedMessageHash(bytes(expected))
    );
  }

  function test_reconfiguringAnInstanceDoesNotAffectOthers() public {
    _setInstance(OTHER_CHAIN_ID, 1, 2);

    LighterTransferRequest memory first = _transfer(
      _build(CHAIN_ID, FROM_ACCOUNT_INDEX)
    );
    assertEq(first.fromAccountIndex, FROM_ACCOUNT_INDEX);
    assertEq(first.lighterChainId, LIGHTER_CHAIN_ID);

    LighterTransferRequest memory second = _transfer(_build(OTHER_CHAIN_ID, 1));
    assertEq(second.fromAccountIndex, 1);
    assertEq(second.lighterChainId, 2);
  }

  function test_revertsWhenFromAccountIndexIsUnset() public {
    string memory unconfigured = "lighter-unconfigured";
    bytes32 key = payloadBuilder.getFromAccountIndexKey(unconfigured);
    _setConfig(
      payloadBuilder.getLighterChainIdKey(unconfigured),
      bytes32(uint256(LIGHTER_CHAIN_ID))
    );

    vm.expectRevert(
      abi.encodeWithSelector(Config.ConfigValueNotSet.selector, key)
    );
    payloadBuilder.getFromAccountIndex(unconfigured);
  }

  function test_revertsWhenLighterChainIdIsUnset() public {
    string memory unconfigured = "lighter-unconfigured";
    _setConfig(
      payloadBuilder.getFromAccountIndexKey(unconfigured),
      bytes32(uint256(FROM_ACCOUNT_INDEX))
    );
    _setConfig(
      payloadBuilder.getFromRouteTypeKey(unconfigured, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getToRouteTypeKey(unconfigured, currency),
      bytes32(0)
    );
    _setConfig(
      payloadBuilder.getAssetIndexKey(unconfigured, currency),
      bytes32(uint256(3))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getLighterChainIdKey(unconfigured)
      )
    );
    _build(unconfigured, FROM_ACCOUNT_INDEX);
  }

  function test_revertsWhenInstanceValueExceedsUint64() public {
    uint256 tooLarge = uint256(type(uint64).max) + 1;
    _setConfig(
      payloadBuilder.getLighterChainIdKey(OTHER_CHAIN_ID),
      bytes32(tooLarge)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.ValueExceedsUint64.selector,
        tooLarge
      )
    );
    payloadBuilder.getLighterChainId(OTHER_CHAIN_ID);
  }

  function test_allocatorRoutesBothInstancesToOneBuilder() public {
    vm.startPrank(owner);
    allocator.setPayloadBuilder(
      CHAIN_ID,
      _uint64Bytes(FROM_ACCOUNT_INDEX),
      address(payloadBuilder)
    );
    allocator.setPayloadBuilder(
      OTHER_CHAIN_ID,
      _uint64Bytes(OTHER_FROM_ACCOUNT_INDEX),
      address(payloadBuilder)
    );
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    vm.stopPrank();

    WithdrawRequest memory first = _params(CHAIN_ID, FROM_ACCOUNT_INDEX);
    WithdrawRequest memory second = _params(
      OTHER_CHAIN_ID,
      OTHER_FROM_ACCOUNT_INDEX
    );
    first.spenderChainId = "ethereum-mainnet";
    first.spender = abi.encodePacked(owner);
    first.data = _transferData(1, 5, 0);
    second.spenderChainId = first.spenderChainId;
    second.spender = first.spender;
    second.data = first.data;

    vm.startPrank(owner);
    hub.mint(
      Utils.generateAddress(first.spenderChainId, first.spender),
      Utils.generateTokenId(CHAIN_ID, currency),
      first.amount
    );
    hub.mint(
      Utils.generateAddress(second.spenderChainId, second.spender),
      Utils.generateTokenId(OTHER_CHAIN_ID, currency),
      second.amount
    );
    bytes32 firstHash = allocator.submitWithdrawRequest(first);
    bytes32 secondHash = allocator.submitWithdrawRequest(second);
    vm.stopPrank();

    LighterTransferRequest memory firstTransfer = _transfer(
      allocator.payloads(firstHash)
    );
    LighterTransferRequest memory secondTransfer = _transfer(
      allocator.payloads(secondHash)
    );
    assertEq(firstTransfer.fromAccountIndex, FROM_ACCOUNT_INDEX);
    assertEq(firstTransfer.lighterChainId, LIGHTER_CHAIN_ID);
    assertEq(secondTransfer.fromAccountIndex, OTHER_FROM_ACCOUNT_INDEX);
    assertEq(secondTransfer.lighterChainId, OTHER_LIGHTER_CHAIN_ID);
    assertNotEq(
      allocator.hashesToSign(firstHash, 0),
      allocator.hashesToSign(secondHash, 0)
    );
  }

  function test_revertsWhenDepositoryIsNotTheConfiguredAccount() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.DepositoryMismatch.selector,
        OTHER_FROM_ACCOUNT_INDEX,
        FROM_ACCOUNT_INDEX
      )
    );
    _build(CHAIN_ID, OTHER_FROM_ACCOUNT_INDEX);
  }

  function test_revertsWhenDepositoryIsEmpty() public {
    WithdrawRequest memory params = _params(CHAIN_ID, FROM_ACCOUNT_INDEX);
    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.DepositoryMismatch.selector,
        uint64(0),
        FROM_ACCOUNT_INDEX
      )
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, "", params);
  }

  function test_acceptsSdkEncodedDepository() public view {
    // The SDK encodes lighter-vm account indices as 16-byte big-endian values.
    bytes memory encoded = abi.encodePacked(uint128(OTHER_FROM_ACCOUNT_INDEX));
    WithdrawRequest memory params = _params(
      OTHER_CHAIN_ID,
      OTHER_FROM_ACCOUNT_INDEX
    );
    params.depository = encoded;
    LighterTransferRequest memory transfer = _transfer(
      buildPayloadOnly(payloadBuilder, OTHER_CHAIN_ID, encoded, params)
    );
    assertEq(transfer.fromAccountIndex, OTHER_FROM_ACCOUNT_INDEX);
  }

  /// @notice The allocator forwards the depository it looked the builder up
  ///         under, so a registration whose depository disagrees with Config
  ///         cannot produce a transfer from the configured account.
  function test_allocatorRejectsRegistrationUnderAnotherDepository() public {
    vm.startPrank(owner);
    allocator.setPayloadBuilder(
      CHAIN_ID,
      _uint64Bytes(OTHER_FROM_ACCOUNT_INDEX),
      address(payloadBuilder)
    );
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    vm.stopPrank();

    WithdrawRequest memory request = _params(
      CHAIN_ID,
      OTHER_FROM_ACCOUNT_INDEX
    );
    request.spenderChainId = "ethereum-mainnet";
    request.spender = abi.encodePacked(owner);
    request.data = _transferData(1, 5, 0);

    vm.startPrank(owner);
    hub.mint(
      Utils.generateAddress(request.spenderChainId, request.spender),
      Utils.generateTokenId(CHAIN_ID, currency),
      request.amount
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        LighterVmPayloadBuilder.DepositoryMismatch.selector,
        OTHER_FROM_ACCOUNT_INDEX,
        FROM_ACCOUNT_INDEX
      )
    );
    allocator.submitWithdrawRequest(request);
    vm.stopPrank();
  }

  function _hex64(bytes32 value) internal pure returns (string memory) {
    bytes16 symbols = "0123456789abcdef";
    bytes memory buffer = new bytes(64);
    for (uint256 i; i < 32; ++i) {
      buffer[i * 2] = symbols[uint8(value[i]) >> 4];
      buffer[i * 2 + 1] = symbols[uint8(value[i]) & 0x0f];
    }
    return string(buffer);
  }
}
