// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {buildPayloadOnly} from "../utils/Payload.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {Config} from "../../contracts/Config.sol";
import {CircleGatewayCodec} from "../../contracts/payload-builders/gateway/CircleGatewayCodec.sol";
import {
  GatewayVmPayload,
  GatewayVmPayloadBuilder,
  GatewayVmPayloadData
} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {GatewaySolanaVmDestinationPayloadBuilder} from "../../contracts/payload-builders/gateway/GatewaySolanaVmDestinationPayloadBuilder.sol";
import {GatewayExecutionParams} from "../../contracts/payload-builders/gateway/IGatewayDestinationPayloadBuilder.sol";
import {SolanaRoutedWithdrawalData} from "../../contracts/payload-builders/SolanaVmPayloadBuilder.sol";
import {
  RelayAllocator,
  WithdrawRequest
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";

/// @notice Covers the Solana Gateway destination adapter, on its own and behind GatewayVmPayloadBuilder.
/// The request vectors are shared with the relay-gateway-depository program's unit tests.
contract GatewaySolanaVmDestinationPayloadBuilderTest is BaseTest {
  string internal constant SOURCE_CHAIN_ID = "arc-gateway";
  string internal constant SOLANA_CHAIN_ID = "solana";
  uint32 internal constant SOURCE_DOMAIN = 26;
  uint32 internal constant SOLANA_DOMAIN = 5;
  uint256 internal constant GAS_FEE = 3_500;
  uint256 internal constant MAX_BLOCK_HEIGHT = 22_000_000;
  uint256 internal constant EXPIRATION_DELAY = 300;

  bytes internal constant TRANSFER_REQUEST_PREFIX =
    "RelayGatewayDepository:TransferRequest:v1";
  bytes internal constant ROUTED_TRANSFER_REQUEST_PREFIX =
    "RelayGatewayDepository:RoutedTransferRequest:v1";

  bytes32 internal constant DOMAIN =
    0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2;
  bytes32 internal constant TRANSFER_SPEC_HASH =
    0x2a01f5587e9faf2b2908b6bb19b2e4f295638407d27de3b5a16ac4f11d355440;
  bytes32 internal constant RECIPIENT =
    0xd354d13253ad4f7764f5c933ccadca795c052d143e2721ff5716848f1fe390cc;
  bytes32 internal constant USDC_MINT =
    0x471500e6828e391e3b31326faa896e01212f976de1ad90ecb7823a2b96e9eb85;
  bytes32 internal constant ROUTER =
    0x7d01d9c59e2296807ea0d4df99ccf825c028060cba6aa00c2ab482dad32161be;
  bytes32 internal constant EXECUTOR =
    0xc7f5fbcec2e7aa03f3be425f739b2eff62ccbd3c86b2b63ba5c7d09a14a1f138;
  bytes32 internal constant DEPOSITORY =
    0x1fa427265aebc381e466efb16f55b95fc3d44af745a3c52f6c599d3a7ec6b19a;
  uint64 internal constant AMOUNT = 1_000_000;
  uint64 internal constant VECTOR_NONCE = 14_041_958_522_398_838_600;
  uint64 internal constant VECTOR_EXPIRATION = 1_700_000_300;

  address internal gatewayAllocator;
  address internal sourceUsdc;

  Config internal config;
  GatewayVmPayloadBuilder internal builder;
  GatewaySolanaVmDestinationPayloadBuilder internal solanaBuilder;

  function setUp() public virtual override {
    super.setUp();
    gatewayAllocator = otherAccounts[0];
    sourceUsdc = otherAccounts[1];

    RelayHub hub = new RelayHub(owner);
    RelayAllocator allocator = new RelayAllocator(
      owner,
      address(hub),
      address(0xbeef)
    );
    config = new Config(address(allocator));
    builder = new GatewayVmPayloadBuilder(address(config));
    solanaBuilder = new GatewaySolanaVmDestinationPayloadBuilder(
      address(config)
    );

    bytes32[] memory keys = new bytes32[](11);
    bytes32[] memory values = new bytes32[](11);
    keys[0] = builder.getCircleDomainKey(SOURCE_CHAIN_ID);
    values[0] = bytes32(uint256(SOURCE_DOMAIN));
    keys[1] = builder.getGasFeeKey(SOURCE_CHAIN_ID);
    values[1] = bytes32(GAS_FEE);
    keys[2] = builder.getDomainTokenKey(SOURCE_CHAIN_ID);
    values[2] = CircleGatewayCodec.addressToBytes32(sourceUsdc);
    keys[3] = builder.getAllocatorAllowedKey(SOURCE_CHAIN_ID, gatewayAllocator);
    values[3] = bytes32(uint256(1));
    keys[4] = builder.getCircleDomainKey(SOLANA_CHAIN_ID);
    values[4] = bytes32(uint256(SOLANA_DOMAIN));
    keys[5] = builder.getDomainTokenKey(SOLANA_CHAIN_ID);
    values[5] = USDC_MINT;
    keys[6] = builder.getDestinationBuilderKey(SOLANA_CHAIN_ID);
    values[6] = CircleGatewayCodec.addressToBytes32(address(solanaBuilder));
    keys[7] = builder.getDestinationDepositoryKey(SOLANA_CHAIN_ID);
    values[7] = DEPOSITORY;
    keys[8] = solanaBuilder.getDomainKey(SOLANA_CHAIN_ID);
    values[8] = DOMAIN;
    keys[9] = solanaBuilder.getExpirationKey();
    values[9] = bytes32(EXPIRATION_DELAY);
    keys[10] = solanaBuilder.getRouterAllowedKey(
      SOLANA_CHAIN_ID,
      DEPOSITORY,
      ROUTER
    );
    values[10] = bytes32(uint256(1));

    vm.prank(owner);
    config.setConfigValues(keys, values);
  }

  function _executionParams()
    internal
    pure
    returns (GatewayExecutionParams memory)
  {
    return
      GatewayExecutionParams({
        destinationChainId: SOLANA_CHAIN_ID,
        transferSpecHash: TRANSFER_SPEC_HASH,
        destinationToken: USDC_MINT,
        depository: abi.encodePacked(DEPOSITORY),
        receiver: abi.encodePacked(RECIPIENT),
        amount: AMOUNT,
        nonce: 123,
        expiration: VECTOR_EXPIRATION,
        data: ""
      });
  }

  function _routedData(bytes32 router) internal pure returns (bytes memory) {
    return
      abi.encode(
        SolanaRoutedWithdrawalData({
          version: 1,
          router: router,
          executor: EXECUTOR
        })
      );
  }

  function _request(uint64 nonce) internal pure returns (bytes memory) {
    return
      bytes.concat(
        DOMAIN,
        TRANSFER_SPEC_HASH,
        RECIPIENT,
        USDC_MINT,
        Utils.encodeUint64LE(AMOUNT),
        Utils.encodeUint64LE(nonce),
        Utils.encodeUint64LE(VECTOR_EXPIRATION)
      );
  }

  function _expectedNonce(
    GatewayExecutionParams memory params
  ) internal view returns (uint64) {
    return
      uint64(
        uint256(
          keccak256(abi.encode(block.number, address(solanaBuilder), params))
        )
      );
  }

  function _withdrawRequest(
    bytes memory destinationData
  ) internal view returns (WithdrawRequest memory) {
    return
      WithdrawRequest({
        chainId: SOURCE_CHAIN_ID,
        depository: abi.encodePacked(address(1)),
        currency: abi.encodePacked(address(0)),
        amount: AMOUNT,
        spenderChainId: "relay",
        spender: abi.encodePacked(address(1)),
        receiver: abi.encodePacked(RECIPIENT),
        data: abi.encode(
          GatewayVmPayloadData({
            allocator: gatewayAllocator,
            destinationChainId: SOLANA_CHAIN_ID,
            maxBlockHeight: MAX_BLOCK_HEIGHT,
            destinationData: destinationData
          })
        ),
        nonce: bytes32(uint256(123))
      });
  }

  function test_returnsGatewayMetadata() public view {
    assertEq(
      solanaBuilder.sourceContract(),
      0x00000000000000000000000077777777dcc4d5a8b6e418fd04d8997ef11000ee
    );
    // GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ
    assertEq(
      solanaBuilder.destinationContract(),
      0xe14b329dba52e324a7a85f52d16d7ef309ff24aa5d7421b0316b568c0e27d78c
    );
    assertEq(solanaBuilder.getExpirationDelay(), EXPIRATION_DELAY);
  }

  function test_buildsTransferRequest() public view {
    GatewayExecutionParams memory params = _executionParams();

    bytes memory payload = solanaBuilder.buildExecutionPayload(params);

    assertEq(payload.length, 193);
    assertEq(
      payload,
      bytes.concat(TRANSFER_REQUEST_PREFIX, _request(_expectedNonce(params)))
    );
  }

  function test_buildsRoutedTransferRequest() public view {
    GatewayExecutionParams memory params = _executionParams();
    params.data = _routedData(ROUTER);

    bytes memory payload = solanaBuilder.buildExecutionPayload(params);

    assertEq(payload.length, 231);
    assertEq(
      payload,
      bytes.concat(
        ROUTED_TRANSFER_REQUEST_PREFIX,
        _request(_expectedNonce(params)),
        ROUTER
      )
    );
  }

  function test_hashesTransferRequestLikeDepositoryProgram() public view {
    bytes memory payload = bytes.concat(
      TRANSFER_REQUEST_PREFIX,
      _request(VECTOR_NONCE)
    );

    assertEq(
      solanaBuilder.hashExecutionPayload(
        SOLANA_CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        payload
      ),
      0xbfb5e4a075619aac92f01c9f769184a34bbc34dd08b5ea708f05242dd8739592
    );
  }

  function test_hashesRoutedTransferRequestLikeDepositoryProgram() public view {
    bytes memory payload = bytes.concat(
      ROUTED_TRANSFER_REQUEST_PREFIX,
      _request(VECTOR_NONCE),
      ROUTER
    );

    assertEq(
      solanaBuilder.hashExecutionPayload(
        SOLANA_CHAIN_ID,
        abi.encodePacked(DEPOSITORY),
        payload
      ),
      0xd52494471653adc327e82464c67862cf00e8e5c163dacd727457ddfdd1dc9dc6
    );
  }

  function test_derivesDifferentNonceAcrossBlocksAndBuilders() public {
    GatewayExecutionParams memory params = _executionParams();
    bytes memory first = solanaBuilder.buildExecutionPayload(params);

    GatewaySolanaVmDestinationPayloadBuilder other = new GatewaySolanaVmDestinationPayloadBuilder(
        address(config)
      );
    assertNotEq(
      keccak256(other.buildExecutionPayload(params)),
      keccak256(first)
    );

    vm.roll(block.number + 1);
    assertNotEq(
      keccak256(solanaBuilder.buildExecutionPayload(params)),
      keccak256(first)
    );
  }

  function test_rejectsInvalidReceiverLength() public {
    GatewayExecutionParams memory params = _executionParams();
    params.receiver = abi.encodePacked(address(1));

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder.InvalidAddressLength.selector,
        20,
        32
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsAmountAboveUint64() public {
    GatewayExecutionParams memory params = _executionParams();
    params.amount = uint256(type(uint64).max) + 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder.ValueExceedsUint64.selector,
        params.amount
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsExpirationAboveInt64() public {
    GatewayExecutionParams memory params = _executionParams();
    params.expiration = uint256(uint64(type(int64).max)) + 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder
          .ExpirationExceedsInt64
          .selector,
        params.expiration
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsUnlistedRouter() public {
    GatewayExecutionParams memory params = _executionParams();
    params.data = _routedData(EXECUTOR);

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        solanaBuilder.getRouterAllowedKey(SOLANA_CHAIN_ID, DEPOSITORY, EXECUTOR)
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsDisabledRouter() public {
    bytes32 key = solanaBuilder.getRouterAllowedKey(
      SOLANA_CHAIN_ID,
      DEPOSITORY,
      ROUTER
    );
    vm.prank(owner);
    config.setConfigValue(key, bytes32(0));
    GatewayExecutionParams memory params = _executionParams();
    params.data = _routedData(ROUTER);

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder.RouterNotAllowed.selector,
        ROUTER
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsRouterAllowlistedForAnotherDepository() public {
    GatewayExecutionParams memory params = _executionParams();
    params.depository = abi.encodePacked(EXECUTOR);
    params.data = _routedData(ROUTER);

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        solanaBuilder.getRouterAllowedKey(SOLANA_CHAIN_ID, EXECUTOR, ROUTER)
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsUnsupportedRoutedDataVersion() public {
    GatewayExecutionParams memory params = _executionParams();
    params.data = abi.encode(
      SolanaRoutedWithdrawalData({
        version: 2,
        router: ROUTER,
        executor: EXECUTOR
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder
          .UnsupportedRoutedDataVersion
          .selector,
        2
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_rejectsRoutedDataWithInvalidDepositoryLength() public {
    GatewayExecutionParams memory params = _executionParams();
    params.depository = abi.encodePacked(address(1));
    params.data = _routedData(ROUTER);

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewaySolanaVmDestinationPayloadBuilder.InvalidAddressLength.selector,
        20,
        32
      )
    );
    solanaBuilder.buildExecutionPayload(params);
  }

  function test_gatewayBuilderRoutesToSolanaDepository() public view {
    WithdrawRequest memory params = _withdrawRequest("");
    bytes memory encodedPayload = buildPayloadOnly(
      builder,
      SOURCE_CHAIN_ID,
      params.depository,
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(payload.burnIntent.spec.destinationDomain, SOLANA_DOMAIN);
    assertEq(
      payload.burnIntent.spec.destinationContract,
      solanaBuilder.GATEWAY_MINTER()
    );
    assertEq(payload.burnIntent.spec.destinationToken, USDC_MINT);
    assertEq(payload.burnIntent.spec.destinationRecipient, DEPOSITORY);
    assertEq(payload.burnIntent.spec.destinationCaller, DEPOSITORY);

    bytes memory execution = payload.executionPayload;
    assertEq(execution.length, 193);
    bytes32 transferSpecHash = CircleGatewayCodec.hashTransferSpec(
      payload.burnIntent.spec
    );
    // The nonce (bytes 177..185) depends on the builder's inputs, so compare around it
    assertEq(
      _slice(execution, 0, 177),
      bytes.concat(
        TRANSFER_REQUEST_PREFIX,
        DOMAIN,
        transferSpecHash,
        RECIPIENT,
        USDC_MINT,
        Utils.encodeUint64LE(AMOUNT)
      )
    );
    assertEq(
      _slice(execution, 185, 8),
      Utils.encodeUint64LE(uint64(block.timestamp + EXPIRATION_DELAY))
    );

    bytes32[] memory hashes = builder.hashesToSign(
      SOURCE_CHAIN_ID,
      params.depository,
      encodedPayload
    );
    assertEq(hashes.length, 2);
    assertEq(hashes[0], CircleGatewayCodec.hashBurnIntent(payload.burnIntent));
    assertEq(hashes[1], sha256(execution));
  }

  function test_gatewayBuilderBuildsRoutedRequest() public view {
    WithdrawRequest memory params = _withdrawRequest(_routedData(ROUTER));
    bytes memory encodedPayload = buildPayloadOnly(
      builder,
      SOURCE_CHAIN_ID,
      params.depository,
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    bytes memory execution = payload.executionPayload;
    assertEq(execution.length, 231);
    assertEq(_slice(execution, 0, 47), ROUTED_TRANSFER_REQUEST_PREFIX);
    assertEq(_slice(execution, 199, 32), abi.encodePacked(ROUTER));

    bytes32[] memory hashes = builder.hashesToSign(
      SOURCE_CHAIN_ID,
      params.depository,
      encodedPayload
    );
    assertEq(hashes[1], sha256(execution));
  }

  function _slice(
    bytes memory data,
    uint256 start,
    uint256 length
  ) internal pure returns (bytes memory out) {
    out = new bytes(length);
    for (uint256 i = 0; i < length; ++i) {
      out[i] = data[start + i];
    }
  }
}
