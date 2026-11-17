// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {
  AtlasVmPayloadBuilder,
  AtlasPayloadHeader,
  AtlasTransfer
} from "../../contracts/payload-builders/AtlasVmPayloadBuilder.sol";

/// @notice Exposes the builder's transaction digest for direct testing
contract AtlasVmPayloadBuilderHarness is AtlasVmPayloadBuilder {
  constructor(address _config) AtlasVmPayloadBuilder(_config) {}

  function transactionDigest(
    AtlasPayloadHeader memory header,
    bytes32 transactionTypehash,
    bytes32 actionHash
  ) external pure returns (bytes32) {
    return _transactionDigest(header, transactionTypehash, actionHash);
  }
}

/// @notice Tests for the Atlas VM payload builder envelope, configuration and transfer payload
contract AtlasVmPayloadBuilderTest is BaseTest {
  string internal constant CHAIN_ID = "atlas-testnet";
  uint256 internal constant NOW_SECONDS = 1_700_000_000;
  address internal constant DEPOSITORY =
    0x1EF18983E5BA8D8F36c0baD4543588b8c28E70BD;
  address internal constant RECEIVER =
    0x299d292dDB5C386bEE485Ed5Ffc9226421ED2947;
  address internal constant SPENDER = address(0xBEEF);
  bytes internal constant USDT = hex"00000000000000000000000000000002";
  uint32 internal constant USDT_ASSET_ID = 2;
  uint8 internal constant USDT_DECIMALS = 6;
  uint64 internal constant GAPLESS_NONCE = 7;
  uint256 internal constant EXPIRATION_DELAY = 1 hours;

  // Atlas testnet transaction domain
  uint256 internal constant DOMAIN_CHAIN_ID = 43003;
  bytes32 internal constant DOMAIN_SALT =
    0xcc279b865244fb243618dfc109dced1cae0e32662920805f8b64813411597338;

  Config internal config;
  AtlasVmPayloadBuilderHarness internal payloadBuilder;

  function setUp() public virtual override {
    super.setUp();
    vm.warp(NOW_SECONDS);

    RelayHub hub = new RelayHub(owner);
    RelayAllocator allocator = new RelayAllocator(
      owner,
      address(hub),
      address(0xbeef)
    );
    config = new Config(address(allocator));
    payloadBuilder = new AtlasVmPayloadBuilderHarness(address(config));

    _setConfig(
      payloadBuilder.getDomainChainIdKey(CHAIN_ID),
      bytes32(DOMAIN_CHAIN_ID)
    );
    _setConfig(payloadBuilder.getDomainSaltKey(CHAIN_ID), DOMAIN_SALT);
    _setConfig(
      payloadBuilder.getAssetDecimalsKey(CHAIN_ID, USDT),
      bytes32(uint256(USDT_DECIMALS))
    );
    _setConfig(
      payloadBuilder.getExpirationKey(CHAIN_ID),
      bytes32(EXPIRATION_DELAY)
    );
  }

  function _setConfig(bytes32 key, bytes32 value) internal {
    vm.prank(owner);
    config.setConfigValue(key, value);
  }

  function _request(
    uint256 nonce
  ) internal pure returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: CHAIN_ID,
        depository: abi.encodePacked(DEPOSITORY),
        currency: USDT,
        amount: 1_000_000,
        spenderChainId: "base",
        spender: abi.encodePacked(SPENDER),
        receiver: abi.encodePacked(RECEIVER),
        data: abi.encode(GAPLESS_NONCE),
        nonce: bytes32(nonce)
      });
  }

  function _buildEncoded(
    WithdrawRequest memory request
  ) internal view returns (bytes memory) {
    return
      buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        request
      );
  }

  function _build(
    WithdrawRequest memory request
  )
    internal
    view
    returns (AtlasPayloadHeader memory header, AtlasTransfer memory transfer)
  {
    (header, transfer) = abi.decode(
      _buildEncoded(request),
      (AtlasPayloadHeader, AtlasTransfer)
    );
  }

  function _buildHeader(
    WithdrawRequest memory request
  ) internal view returns (AtlasPayloadHeader memory header) {
    (header, ) = _build(request);
  }

  function _buildTransfer(
    WithdrawRequest memory request
  ) internal view returns (AtlasTransfer memory transfer) {
    (, transfer) = _build(request);
  }

  function test_buildPayloadEncodesTheTransfer() public view {
    WithdrawRequest memory request = _request(7);
    // Header and transfer are both static, so the payload is exactly 6 + 6 words
    assertEq(_buildEncoded(request).length, 12 * 32);
    (AtlasPayloadHeader memory payload, AtlasTransfer memory transfer) = _build(
      request
    );

    assertEq(payload.domainChainId, DOMAIN_CHAIN_ID);
    assertEq(payload.domainSalt, DOMAIN_SALT);
    assertEq(payload.signer, DEPOSITORY);
    assertEq(payload.nonce, GAPLESS_NONCE);
    assertEq(payload.expiresAt, NOW_SECONDS + EXPIRATION_DELAY);
    assertEq(payload.actionType, payloadBuilder.TRANSFER_ACTION_TYPE());

    assertEq(transfer.fromAccountAddress, DEPOSITORY);
    assertEq(transfer.toAccountAddress, RECEIVER);
    assertEq(transfer.assetId, USDT_ASSET_ID);
    assertEq(transfer.amount, int128(int256(request.amount * 1e6)));
    assertEq(
      transfer.memoHead,
      keccak256(abi.encode(address(payloadBuilder), request))
    );
    assertEq(transfer.memoTail, bytes32(uint256(GAPLESS_NONCE)));
  }

  function test_memoSeparatesIdenticalTransfersFromTwoSpenders() public view {
    WithdrawRequest memory other = _request(7);
    other.spender = abi.encodePacked(RECEIVER);
    AtlasTransfer memory first = _buildTransfer(_request(7));
    AtlasTransfer memory second = _buildTransfer(other);

    assertNotEq(first.memoHead, second.memoHead);
  }

  function test_revertsOnNoncesBelowTheFirstWithdrawalNonce() public {
    WithdrawRequest memory request = _request(7);
    for (uint64 nonce = 0; nonce < payloadBuilder.MIN_NONCE(); ++nonce) {
      request.data = abi.encode(nonce);
      vm.expectRevert(
        abi.encodeWithSelector(
          AtlasVmPayloadBuilder.InvalidNonce.selector,
          nonce
        )
      );
      buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        request
      );
    }

    request.data = abi.encode(payloadBuilder.MIN_NONCE());
    assertEq(_buildHeader(request).nonce, payloadBuilder.MIN_NONCE());
  }

  function test_revertsWhenTheRequestCarriesNoNonce() public {
    WithdrawRequest memory request = _request(7);
    request.data = "";

    vm.expectRevert();
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsWhenTheNonceExceedsUint64() public {
    WithdrawRequest memory request = _request(7);
    request.data = abi.encode(uint256(type(uint64).max) + 1);

    vm.expectRevert();
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_expiresAfterTheConfiguredDelay() public {
    _setConfig(
      payloadBuilder.getExpirationKey(CHAIN_ID),
      bytes32(payloadBuilder.MAX_EXPIRATION_DELAY())
    );

    assertEq(_buildHeader(_request(7)).expiresAt, NOW_SECONDS + 14 days);
  }

  function test_revertsWhenTheExpirationDelayExceedsTheAtlasLimit() public {
    uint256 delay = payloadBuilder.MAX_EXPIRATION_DELAY() + 1;
    _setConfig(payloadBuilder.getExpirationKey(CHAIN_ID), bytes32(delay));

    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.InvalidExpirationDelay.selector,
        delay
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      _request(7)
    );
  }

  function test_revertsWhenExpirationIsUnset() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getExpirationKey("atlas")
      )
    );
    payloadBuilder.getExpirationDelay("atlas");
  }

  function test_readsTheConfiguredDomain() public view {
    assertEq(payloadBuilder.getDomainChainId(CHAIN_ID), DOMAIN_CHAIN_ID);
    assertEq(payloadBuilder.getDomainSalt(CHAIN_ID), DOMAIN_SALT);
  }

  function test_revertsWhenDomainIsUnset() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getDomainChainIdKey("atlas")
      )
    );
    payloadBuilder.getDomainChainId("atlas");
  }

  function test_revertsWhenSaltIsUnset() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getDomainSaltKey("atlas")
      )
    );
    payloadBuilder.getDomainSalt("atlas");
  }

  function test_revertsOnDepositoryLength() public {
    vm.expectRevert(
      abi.encodeWithSelector(AtlasVmPayloadBuilder.InvalidLength.selector, 16)
    );
    buildPayloadOnly(payloadBuilder, CHAIN_ID, new bytes(16), _request(7));
  }

  function test_revertsOnReceiverLength() public {
    WithdrawRequest memory request = _request(7);
    request.receiver = abi.encodePacked(uint128(256));

    vm.expectRevert(
      abi.encodeWithSelector(AtlasVmPayloadBuilder.InvalidLength.selector, 16)
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsOnZeroReceiver() public {
    WithdrawRequest memory request = _request(7);
    request.receiver = abi.encodePacked(address(0));

    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.InvalidReceiver.selector,
        address(0)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsWhenReceiverIsTheDepository() public {
    WithdrawRequest memory request = _request(7);
    request.receiver = abi.encodePacked(DEPOSITORY);

    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.InvalidReceiver.selector,
        DEPOSITORY
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsOnZeroAmount() public {
    WithdrawRequest memory request = _request(7);
    request.amount = 0;

    vm.expectRevert(
      abi.encodeWithSelector(AtlasVmPayloadBuilder.InvalidAmount.selector, 0)
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsOnUnconfiguredCurrency() public {
    WithdrawRequest memory request = _request(7);
    request.currency = hex"00000000000000000000000000000001";

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getAssetDecimalsKey(CHAIN_ID, request.currency)
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsWhenAssetIdExceedsUint32() public {
    WithdrawRequest memory request = _request(7);
    request.currency = abi.encodePacked(uint128(type(uint32).max) + 1);
    _setConfig(
      payloadBuilder.getAssetDecimalsKey(CHAIN_ID, request.currency),
      bytes32(uint256(USDT_DECIMALS))
    );

    vm.expectRevert(SafeCastLib.Overflow.selector);
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsOnCurrencyLength() public {
    WithdrawRequest memory request = _request(7);
    request.currency = hex"02";

    vm.expectRevert(
      abi.encodeWithSelector(AtlasVmPayloadBuilder.InvalidLength.selector, 1)
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_revertsWhenDecimalsExceedTheSignedScale() public {
    _setConfig(
      payloadBuilder.getAssetDecimalsKey(CHAIN_ID, USDT),
      bytes32(uint256(13))
    );

    vm.expectRevert(
      abi.encodeWithSelector(AtlasVmPayloadBuilder.InvalidDecimals.selector, 13)
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      _request(7)
    );
  }

  function test_revertsWhenTheSignedAmountOverflowsInt128() public {
    WithdrawRequest memory request = _request(7);
    request.amount = uint256(int256(type(int128).max)) / 1e6 + 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.InvalidAmount.selector,
        request.amount
      )
    );
    buildPayloadOnly(
      payloadBuilder,
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      request
    );
  }

  function test_typehashMatchesThePublishedTransferType() public view {
    assertEq(
      payloadBuilder.TRANSFER_TRANSACTION_TYPEHASH(),
      0x3b16569076c858403f01465d87aa7c6c0cee1cafa3cd06e1fc7c723a12b32451
    );
  }

  function test_hashTransferMatchesTheSdkVectorsActionHash() public view {
    (, AtlasTransfer memory transfer) = _sdkVector();

    assertEq(
      payloadBuilder.hashTransfer(transfer),
      0xca91ddf9dc7b4ac96e57d68c097c314bb85c9735267388c8b9997457ab2b8f96
    );
  }

  function test_hashesToSignMatchesTheSdkVector() public view {
    // The settlement SDK atlas-vm codec test derives the same transfer id
    (
      AtlasPayloadHeader memory header,
      AtlasTransfer memory transfer
    ) = _sdkVector();

    assertEq(
      payloadBuilder.hashesToSign(
        CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        abi.encode(header, transfer)
      )[0],
      0x7b533dfc4b8b8bbb898f8c7291a32983c3dbec4bff489c705c4b3a223c2c4c6f
    );
  }

  function test_payloadEncodingMatchesTheSdkVector() public pure {
    // The settlement SDK atlas-vm codec test pins the same bytes
    (
      AtlasPayloadHeader memory header,
      AtlasTransfer memory transfer
    ) = _sdkVector();

    assertEq(
      abi.encode(header, transfer),
      hex"000000000000000000000000000000000000000000000000000000000000a7fbcc279b865244fb243618dfc109dced1cae0e32662920805f8b648134115973380000000000000000000000001ef18983e5ba8d8f36c0bad4543588b8c28e70bd0000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000006553ff1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001ef18983e5ba8d8f36c0bad4543588b8c28e70bd000000000000000000000000299d292ddb5c386bee485ed5ffc9226421ed29470000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000e8d4a510006f72642d343200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007"
    );
  }

  function _sdkVector()
    internal
    pure
    returns (AtlasPayloadHeader memory header, AtlasTransfer memory transfer)
  {
    transfer = AtlasTransfer({
      fromAccountAddress: DEPOSITORY,
      toAccountAddress: RECEIVER,
      assetId: USDT_ASSET_ID,
      amount: 1_000_000_000_000,
      memoHead: bytes32("ord-42"),
      memoTail: bytes32(uint256(GAPLESS_NONCE))
    });
    header = AtlasPayloadHeader({
      domainChainId: DOMAIN_CHAIN_ID,
      domainSalt: DOMAIN_SALT,
      signer: DEPOSITORY,
      nonce: GAPLESS_NONCE,
      expiresAt: uint64(NOW_SECONDS + EXPIRATION_DELAY),
      actionType: 0
    });
  }

  function test_buildPayloadScalesByTheConfiguredDecimals() public {
    _setConfig(
      payloadBuilder.getAssetDecimalsKey(CHAIN_ID, USDT),
      bytes32(uint256(12))
    );
    AtlasTransfer memory transfer = _buildTransfer(_request(7));

    assertEq(transfer.amount, int128(int256(_request(7).amount)));
  }

  function test_hashesToSignRejectsUnsupportedActions() public {
    (AtlasPayloadHeader memory header, AtlasTransfer memory transfer) = _build(
      _request(7)
    );
    header.actionType = 1;
    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.UnsupportedActionType.selector,
        1
      )
    );
    payloadBuilder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      abi.encode(header, transfer)
    );
  }

  function test_hashesToSignRejectsUnsupportedActionsOfAnyLayout() public {
    // Another action type need not follow the header with a transfer
    AtlasPayloadHeader memory header = _buildHeader(_request(7));
    header.actionType = 1;
    vm.expectRevert(
      abi.encodeWithSelector(
        AtlasVmPayloadBuilder.UnsupportedActionType.selector,
        1
      )
    );
    payloadBuilder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      abi.encode(header)
    );
  }

  function test_hashesToSignReturnsOneHashForABuiltPayload() public view {
    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(DEPOSITORY),
      buildPayloadOnly(
        payloadBuilder,
        CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        _request(7)
      )
    );

    assertEq(hashes.length, 1);
  }

  function test_curveAndFamily() public view {
    assertEq(payloadBuilder.curve(), "Ecdsa");
    assertEq(payloadBuilder.family(), "atlas-vm");
  }
}
