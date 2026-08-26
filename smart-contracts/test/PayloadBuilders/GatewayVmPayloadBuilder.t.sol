// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {PayGasSig} from "../utils/PayGasSig.sol";
import {Config} from "../../contracts/Config.sol";
import {CircleGatewayCodec} from "../../contracts/payload-builders/gateway/CircleGatewayCodec.sol";
import {
  BurnIntent,
  CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION
} from "../../contracts/payload-builders/gateway/CircleGatewayTypes.sol";
import {
  GatewayVmPayload,
  GatewayVmPayloadBuilder,
  GatewayVmPayloadData
} from "../../contracts/payload-builders/GatewayVmPayloadBuilder.sol";
import {
  Call,
  CallRequest,
  GatewayEthereumVmDestinationPayloadBuilder,
  RoutedWithdrawalData
} from "../../contracts/payload-builders/gateway/GatewayEthereumVmDestinationPayloadBuilder.sol";
import {
  GatewayExecutionParams,
  IGatewayDestinationPayloadBuilder
} from "../../contracts/payload-builders/gateway/IGatewayDestinationPayloadBuilder.sol";
import {
  BuildPayloadParams,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {EthereumVmPayloadBuilder} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {
  GasPaidPayloadBuilder,
  IWithdrawGasPayer,
  WithdrawParams
} from "../../contracts/payload-builders/GasPaidPayloadBuilder.sol";
import {
  Call as RouterCall,
  IMulticallRouter
} from "../../contracts/routers/IMulticallRouter.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";

contract MockWithdrawGasPayer is IWithdrawGasPayer {
  uint256 internal paymentAmount;

  function setPaymentAmount(uint256 amount) external {
    paymentAmount = amount;
  }

  function gasPayments(bytes32) external view returns (uint256 amount) {
    return paymentAmount;
  }
}

struct MockSolanaExecutionRequest {
  bytes32 transferSpecHash;
  bytes receiver;
  uint256 amount;
  uint256 nonce;
  uint256 expiration;
  bytes data;
}

contract MockSolanaGatewayDestinationPayloadBuilder is
  IGatewayDestinationPayloadBuilder
{
  error InvalidAddressLength(uint256 length);

  bytes32 internal constant GATEWAY_WALLET =
    0x00000000000000000000000077777777dcc4d5a8b6e418fd04d8997ef11000ee;
  bytes32 internal constant GATEWAY_MINTER =
    0x3333333333333333333333333333333333333333333333333333333333333333;

  function sourceContract() external pure returns (bytes32) {
    return GATEWAY_WALLET;
  }

  function destinationContract() external pure returns (bytes32) {
    return GATEWAY_MINTER;
  }

  function getExpirationDelay() external pure returns (uint256) {
    return 10 days;
  }

  function buildExecutionPayload(
    GatewayExecutionParams calldata params
  ) external pure returns (bytes memory payload) {
    if (params.depository.length != 32) {
      revert InvalidAddressLength(params.depository.length);
    }
    if (params.receiver.length != 32) {
      revert InvalidAddressLength(params.receiver.length);
    }
    return
      abi.encode(
        MockSolanaExecutionRequest({
          transferSpecHash: params.transferSpecHash,
          receiver: params.receiver,
          amount: params.amount,
          nonce: params.nonce,
          expiration: params.expiration,
          data: params.data
        })
      );
  }

  function hashExecutionPayload(
    string calldata destinationChainId,
    bytes calldata depository,
    bytes calldata payload
  ) external pure returns (bytes32 digest) {
    return keccak256(abi.encode(destinationChainId, depository, payload));
  }
}

abstract contract GatewayVmPayloadBuilderBase is BaseTest {
  string internal constant CHAIN_ID = "gateway";
  uint32 internal constant SOURCE_DOMAIN = 3;
  uint32 internal constant EVM_DESTINATION_DOMAIN = 6;
  uint256 internal constant DESTINATION_EVM_CHAIN_ID = 8453;
  uint256 internal constant MAX_BLOCK_HEIGHT = 22_000_000;
  uint256 internal constant GAS_FEE = 50_000;
  uint256 internal constant CROSSCHAIN_TRANSFER_FEE = 50;
  uint256 internal constant PAID_GAS = GAS_FEE + CROSSCHAIN_TRANSFER_FEE;
  uint256 internal constant EXPIRATION_DELAY = 10 days;
  string internal constant EVM_SUBCHAIN_ID = "8453";

  address internal gatewayAllocator;
  address internal evmDestinationDepository;
  address internal receiver;
  address internal sourceUsdc;
  address internal destinationUsdc;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  MockWithdrawGasPayer internal gasPayer;
  GatewayVmPayloadBuilder internal builder;
  EthereumVmPayloadBuilder internal ethereumVmBuilder;
  GatewayEthereumVmDestinationPayloadBuilder internal evmBuilder;

  function setUp() public virtual override {
    super.setUp();
    gatewayAllocator = otherAccounts[0];
    evmDestinationDepository = otherAccounts[4];
    receiver = otherAccounts[5];
    sourceUsdc = otherAccounts[6];
    destinationUsdc = otherAccounts[7];

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    gasPayer = new MockWithdrawGasPayer();
    gasPayer.setPaymentAmount(PAID_GAS);
    builder = new GatewayVmPayloadBuilder(address(config), address(gasPayer));
    ethereumVmBuilder = new EthereumVmPayloadBuilder(address(config));
    evmBuilder = new GatewayEthereumVmDestinationPayloadBuilder(
      address(config)
    );

    bytes32[] memory keys = new bytes32[](10);
    bytes32[] memory values = new bytes32[](10);
    keys[0] = builder.getCircleDomainKey(CHAIN_ID);
    values[0] = bytes32(uint256(SOURCE_DOMAIN));
    keys[1] = builder.getGasFeeKey(CHAIN_ID);
    values[1] = bytes32(GAS_FEE);
    keys[2] = builder.getDomainTokenKey(CHAIN_ID);
    values[2] = _encodeEvmAddress(sourceUsdc);
    keys[3] = builder.getDomainTokenKey(EVM_SUBCHAIN_ID);
    values[3] = _encodeEvmAddress(destinationUsdc);
    keys[4] = builder.getDestinationBuilderKey(EVM_SUBCHAIN_ID);
    values[4] = _encodeEvmAddress(address(evmBuilder));
    keys[5] = ethereumVmBuilder.getEvmChainIdKey(EVM_SUBCHAIN_ID);
    values[5] = bytes32(DESTINATION_EVM_CHAIN_ID);
    keys[6] = ethereumVmBuilder.getExpirationKey();
    values[6] = bytes32(EXPIRATION_DELAY);
    keys[7] = builder.getCircleDomainKey(EVM_SUBCHAIN_ID);
    values[7] = bytes32(uint256(EVM_DESTINATION_DOMAIN));
    keys[8] = builder.getAllocatorAllowedKey(gatewayAllocator);
    values[8] = bytes32(uint256(1));
    keys[9] = builder.getDestinationDepositoryKey(EVM_SUBCHAIN_ID);
    values[9] = _encodeEvmAddress(evmDestinationDepository);

    vm.prank(owner);
    config.setConfigValues(keys, values);
  }

  function _params() internal view returns (BuildPayloadParams memory) {
    return
      BuildPayloadParams({
        currency: abi.encodePacked(address(0)),
        amount: 1_000_000,
        receiver: abi.encodePacked(receiver),
        nonce: 123,
        data: abi.encode(
          GatewayVmPayloadData({
            allocator: gatewayAllocator,
            destinationChainId: EVM_SUBCHAIN_ID,
            maxBlockHeight: MAX_BLOCK_HEIGHT,
            destinationData: ""
          })
        )
      });
  }

  function _buildEvmPayload() internal view returns (GatewayVmPayload memory) {
    bytes memory encoded = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _params()
    );
    return abi.decode(encoded, (GatewayVmPayload));
  }

  function _routedParams(
    address router,
    bytes32 dataHash
  ) internal view returns (BuildPayloadParams memory params) {
    params = _params();
    params.data = abi.encode(
      GatewayVmPayloadData({
        allocator: gatewayAllocator,
        destinationChainId: EVM_SUBCHAIN_ID,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        destinationData: abi.encode(
          RoutedWithdrawalData({version: 1, router: router, dataHash: dataHash})
        )
      })
    );
  }

  /// @notice Recomputes the nonce the EVM destination builder derives for an execution request
  function _expectedExecutionNonce(
    bytes32 transferSpecHash,
    BuildPayloadParams memory params,
    uint256 expiration,
    bytes memory destinationData
  ) internal view returns (uint256) {
    return
      uint256(
        keccak256(
          abi.encode(
            block.number,
            address(evmBuilder),
            GatewayExecutionParams({
              destinationChainId: EVM_SUBCHAIN_ID,
              transferSpecHash: transferSpecHash,
              destinationToken: _encodeEvmAddress(destinationUsdc),
              depository: abi.encodePacked(
                _encodeEvmAddress(evmDestinationDepository)
              ),
              receiver: params.receiver,
              amount: params.amount,
              nonce: params.nonce,
              expiration: expiration,
              data: destinationData
            })
          )
        )
      );
  }

  function _setConfig(bytes32 key, bytes32 value) internal {
    vm.prank(owner);
    config.setConfigValue(key, value);
  }

  function _encodeEvmAddress(address value) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(value)));
  }
}

contract GatewayVmPayloadBuilderBuildPayloadTest is
  GatewayVmPayloadBuilderBase
{
  function test_storesGasPayer() public view {
    assertEq(builder.GAS_PAYER(), address(gasPayer));
  }

  function test_rejectsBuildWithoutGasPayment() public {
    BuildPayloadParams memory params = _params();
    bytes memory depository = abi.encodePacked(evmDestinationDepository);
    gasPayer.setPaymentAmount(0);

    vm.expectRevert(
      abi.encodeWithSelector(
        GasPaidPayloadBuilder.GasNotPaid.selector,
        WithdrawParams.hash(CHAIN_ID, depository, params)
      )
    );
    builder.buildPayload(CHAIN_ID, depository, params);
  }

  function test_rejectsCircleFeeAbovePaidGas() public {
    uint256 underpayment = PAID_GAS - 1;
    gasPayer.setPaymentAmount(underpayment);

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayVmPayloadBuilder.FeeExceedsPaidGas.selector,
        PAID_GAS,
        underpayment
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _params()
    );
  }

  function test_allowsCircleFeeEqualToPaidGas() public view {
    GatewayVmPayload memory payload = _buildEvmPayload();
    assertEq(payload.burnIntent.maxFee, PAID_GAS);
  }

  function test_reusesEthereumVmConfig() public view {
    assertEq(
      evmBuilder.getExpirationKey(),
      ethereumVmBuilder.getExpirationKey()
    );
    assertEq(
      evmBuilder.getEvmChainIdKey(EVM_SUBCHAIN_ID),
      ethereumVmBuilder.getEvmChainIdKey(EVM_SUBCHAIN_ID)
    );
    assertEq(evmBuilder.getExpirationDelay(), EXPIRATION_DELAY);
  }

  function test_reusesEthereumVmRouterAllowlistConfig() public view {
    address router = address(0xBEEF);

    assertEq(
      evmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      ),
      ethereumVmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      )
    );
  }

  function test_usesChainScopedConfigKeys() public view {
    string memory alternateChainId = "gateway-base";

    assertNotEq(
      builder.getCircleDomainKey(CHAIN_ID),
      builder.getCircleDomainKey(alternateChainId)
    );
    assertNotEq(
      builder.getGasFeeKey(CHAIN_ID),
      builder.getGasFeeKey(alternateChainId)
    );
    assertNotEq(
      builder.getDomainTokenKey(CHAIN_ID),
      builder.getDomainTokenKey(alternateChainId)
    );
    assertNotEq(
      builder.getDestinationBuilderKey(EVM_SUBCHAIN_ID),
      builder.getDestinationBuilderKey(alternateChainId)
    );
  }

  function test_rejectsUnlistedAllocator() public {
    address unlistedAllocator = otherAccounts[3];
    BuildPayloadParams memory params = _params();
    params.data = abi.encode(
      GatewayVmPayloadData({
        allocator: unlistedAllocator,
        destinationChainId: EVM_SUBCHAIN_ID,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        destinationData: ""
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayVmPayloadBuilder.AllocatorNotAllowed.selector,
        unlistedAllocator
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
  }

  function test_selectsAnotherAllowedAllocatorFromData() public {
    address secondAllocator = otherAccounts[3];
    _setConfig(
      builder.getAllocatorAllowedKey(secondAllocator),
      bytes32(uint256(1))
    );

    BuildPayloadParams memory params = _params();
    params.data = abi.encode(
      GatewayVmPayloadData({
        allocator: secondAllocator,
        destinationChainId: EVM_SUBCHAIN_ID,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        destinationData: ""
      })
    );
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(
      payload.burnIntent.spec.sourceDepositor,
      _encodeEvmAddress(secondAllocator)
    );
    assertEq(
      payload.burnIntent.spec.sourceSigner,
      _encodeEvmAddress(secondAllocator)
    );
  }

  function test_buildsEvmPayload() public view {
    BuildPayloadParams memory params = _params();
    bytes memory depository = abi.encodePacked(evmDestinationDepository);
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      depository,
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );
    BurnIntent memory intent = payload.burnIntent;

    assertEq(intent.maxBlockHeight, MAX_BLOCK_HEIGHT);
    assertEq(intent.maxFee, GAS_FEE + 50);
    assertEq(intent.spec.version, CIRCLE_GATEWAY_TRANSFER_SPEC_VERSION);
    assertEq(intent.spec.sourceDomain, SOURCE_DOMAIN);
    assertEq(intent.spec.destinationDomain, EVM_DESTINATION_DOMAIN);
    assertEq(intent.spec.sourceContract, evmBuilder.GATEWAY_WALLET());
    assertEq(intent.spec.destinationContract, evmBuilder.GATEWAY_MINTER());
    assertEq(intent.spec.sourceToken, _encodeEvmAddress(sourceUsdc));
    assertEq(intent.spec.destinationToken, _encodeEvmAddress(destinationUsdc));
    assertEq(intent.spec.sourceDepositor, _encodeEvmAddress(gatewayAllocator));
    assertEq(
      intent.spec.destinationRecipient,
      _encodeEvmAddress(evmDestinationDepository)
    );
    assertEq(
      intent.spec.destinationCaller,
      _encodeEvmAddress(evmDestinationDepository)
    );
    assertEq(intent.spec.sourceSigner, _encodeEvmAddress(gatewayAllocator));
    assertEq(intent.spec.value, 1_000_000);
    assertEq(
      intent.spec.salt,
      keccak256(abi.encode(address(builder), CHAIN_ID, depository, params))
    );
    assertEq(intent.spec.hookData, "");
    bytes32 transferSpecHash = CircleGatewayCodec.hashTransferSpec(intent.spec);

    CallRequest memory request = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );
    assertEq(request.transferSpecHash, transferSpecHash);
    assertEq(request.calls.length, 1);
    assertEq(request.calls[0].to, destinationUsdc);
    assertEq(
      request.calls[0].data,
      abi.encodeWithSignature(
        "transfer(address,uint256)",
        receiver,
        intent.spec.value
      )
    );
    assertEq(request.calls[0].dataHash, bytes32(0));
    assertEq(request.calls[0].value, 0);
    assertFalse(request.calls[0].allowFailure);
    assertEq(
      request.nonce,
      _expectedExecutionNonce(
        transferSpecHash,
        params,
        block.timestamp + EXPIRATION_DELAY,
        ""
      )
    );
    assertTrue(request.nonce != params.nonce);
    assertEq(request.expiration, block.timestamp + EXPIRATION_DELAY);
  }

  function test_buildsTransferAndCommittedRouterCall() public {
    address router = address(0xBEEF);
    RouterCall[] memory routerCalls = new RouterCall[](1);
    routerCalls[0] = RouterCall({
      to: receiver,
      data: hex"deadbeef",
      value: 0,
      allowFailure: false
    });
    bytes memory routerData = abi.encodeCall(
      IMulticallRouter.multicall,
      (routerCalls)
    );
    bytes32 dataHash = keccak256(routerData);
    _setConfig(
      evmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      ),
      bytes32(uint256(1))
    );

    GatewayVmPayload memory payload = abi.decode(
      builder.buildPayload(
        CHAIN_ID,
        abi.encodePacked(evmDestinationDepository),
        _routedParams(router, dataHash)
      ),
      (GatewayVmPayload)
    );
    CallRequest memory request = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );

    assertEq(request.calls.length, 2);
    assertEq(request.calls[0].to, destinationUsdc);
    assertEq(
      request.calls[0].data,
      abi.encodeWithSignature("transfer(address,uint256)", receiver, 1_000_000)
    );
    assertEq(request.calls[0].dataHash, bytes32(0));
    assertEq(request.calls[1].to, router);
    assertEq(request.calls[1].data, "");
    assertEq(request.calls[1].dataHash, dataHash);
    assertEq(request.calls[1].value, 0);
    assertFalse(request.calls[1].allowFailure);

    CallRequest memory executable = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );
    executable.calls[1].data = routerData;
    executable.calls[1].dataHash = bytes32(0);
    assertEq(
      evmBuilder.hashExecutionPayload(
        EVM_SUBCHAIN_ID,
        abi.encodePacked(evmDestinationDepository),
        payload.executionPayload
      ),
      evmBuilder.hashExecutionPayload(
        EVM_SUBCHAIN_ID,
        abi.encodePacked(evmDestinationDepository),
        abi.encode(executable)
      )
    );
  }

  function test_rejectsUnlistedRouter() public {
    address router = address(0xBEEF);
    BuildPayloadParams memory params = _routedParams(
      router,
      keccak256("router calldata")
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        evmBuilder.getRouterAllowedKey(
          EVM_SUBCHAIN_ID,
          evmDestinationDepository,
          router
        )
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
  }

  function test_rejectsDegenerateRouterDataHash() public {
    address router = address(0xBEEF);
    _setConfig(
      evmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      ),
      bytes32(uint256(1))
    );

    vm.expectRevert(
      GatewayEthereumVmDestinationPayloadBuilder.EmptyRoutedCallsHash.selector
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _routedParams(router, bytes32(0))
    );
  }

  function test_rejectsEmptyCalldataRouterDataHash() public {
    address router = address(0xBEEF);
    _setConfig(
      evmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      ),
      bytes32(uint256(1))
    );

    vm.expectRevert(
      GatewayEthereumVmDestinationPayloadBuilder.EmptyRoutedCallsHash.selector
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _routedParams(router, keccak256(""))
    );
  }

  function test_rejectsUnsupportedRoutedDataVersion() public {
    address router = address(0xBEEF);
    BuildPayloadParams memory params = _routedParams(
      router,
      keccak256("router calldata")
    );
    GatewayVmPayloadData memory data = abi.decode(
      params.data,
      (GatewayVmPayloadData)
    );
    data.destinationData = abi.encode(
      RoutedWithdrawalData({
        version: 2,
        router: router,
        dataHash: keccak256("router calldata")
      })
    );
    params.data = abi.encode(data);

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayEthereumVmDestinationPayloadBuilder
          .UnsupportedRoutedDataVersion
          .selector,
        uint8(2)
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
  }

  function test_rejectsDisabledRouter() public {
    address router = address(0xBEEF);
    _setConfig(
      evmBuilder.getRouterAllowedKey(
        EVM_SUBCHAIN_ID,
        evmDestinationDepository,
        router
      ),
      bytes32(uint256(2))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayEthereumVmDestinationPayloadBuilder.RouterNotAllowed.selector,
        router
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _routedParams(router, keccak256("router calldata"))
    );
  }

  function test_changesTransferSpecHashForDifferentReceiverWithSameNonce()
    public
    view
  {
    bytes memory depository = abi.encodePacked(evmDestinationDepository);
    BuildPayloadParams memory firstParams = _params();
    BuildPayloadParams memory secondParams = _params();
    secondParams.receiver = abi.encodePacked(otherAccounts[6]);

    GatewayVmPayload memory first = abi.decode(
      builder.buildPayload(CHAIN_ID, depository, firstParams),
      (GatewayVmPayload)
    );
    GatewayVmPayload memory second = abi.decode(
      builder.buildPayload(CHAIN_ID, depository, secondParams),
      (GatewayVmPayload)
    );

    assertEq(firstParams.nonce, secondParams.nonce);
    assertNotEq(first.burnIntent.spec.salt, second.burnIntent.spec.salt);
    assertNotEq(
      CircleGatewayCodec.hashTransferSpec(first.burnIntent.spec),
      CircleGatewayCodec.hashTransferSpec(second.burnIntent.spec)
    );
  }

  function test_roundsCrosschainTransferFeeUp() public view {
    BuildPayloadParams memory params = _params();
    params.amount = 1;

    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(payload.burnIntent.maxFee, GAS_FEE + 1);
  }

  function test_excludesTransferFeeFromSameDomainMaxFee() public {
    bytes32[] memory keys = new bytes32[](4);
    bytes32[] memory values = new bytes32[](4);
    keys[0] = builder.getDestinationBuilderKey(EVM_SUBCHAIN_ID);
    values[0] = _encodeEvmAddress(address(evmBuilder));
    keys[1] = ethereumVmBuilder.getEvmChainIdKey(EVM_SUBCHAIN_ID);
    values[1] = bytes32(DESTINATION_EVM_CHAIN_ID);
    keys[2] = builder.getDestinationDepositoryKey(EVM_SUBCHAIN_ID);
    values[2] = _encodeEvmAddress(evmDestinationDepository);
    keys[3] = builder.getCircleDomainKey(EVM_SUBCHAIN_ID);
    values[3] = bytes32(uint256(SOURCE_DOMAIN));

    vm.prank(owner);
    config.setConfigValues(keys, values);

    BuildPayloadParams memory params = _params();
    params.data = abi.encode(
      GatewayVmPayloadData({
        allocator: gatewayAllocator,
        destinationChainId: EVM_SUBCHAIN_ID,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        destinationData: ""
      })
    );
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(payload.burnIntent.maxFee, GAS_FEE);
  }

  function test_keepsBurnIntentDeterministicAcrossBlocks() public {
    GatewayVmPayload memory first = _buildEvmPayload();

    vm.roll(block.number + 100);
    vm.warp(block.timestamp + 1 hours);
    GatewayVmPayload memory second = _buildEvmPayload();

    assertEq(
      keccak256(abi.encode(first.burnIntent)),
      keccak256(abi.encode(second.burnIntent))
    );
    assertNotEq(
      keccak256(first.executionPayload),
      keccak256(second.executionPayload)
    );
  }

  function test_usesConfiguredDestinationDepository() public view {
    address sourceDepository = address(0x1234);
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(sourceDepository),
      _params()
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(
      payload.burnIntent.spec.destinationRecipient,
      _encodeEvmAddress(evmDestinationDepository)
    );
    assertEq(
      payload.burnIntent.spec.destinationCaller,
      _encodeEvmAddress(evmDestinationDepository)
    );
  }

  function test_rejectsNonCanonicalCurrency() public {
    BuildPayloadParams memory params = _params();
    params.currency = abi.encodePacked(sourceUsdc);

    vm.expectRevert(
      abi.encodeWithSelector(
        GatewayVmPayloadBuilder.InvalidCurrency.selector,
        sourceUsdc
      )
    );
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
  }

  function test_rejectsUnlistedDestinationChain() public {
    GatewayVmPayloadData memory data = GatewayVmPayloadData({
      allocator: gatewayAllocator,
      destinationChainId: "unknown",
      maxBlockHeight: MAX_BLOCK_HEIGHT,
      destinationData: ""
    });
    BuildPayloadParams memory params = _params();
    params.data = abi.encode(data);

    vm.expectRevert();
    builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      params
    );
  }
}

contract GatewayVmPayloadBuilderGasPaymentIntegrationTest is
  GatewayVmPayloadBuilderBase
{
  string internal constant SPENDER_CHAIN_ID = "ethereum-mainnet";

  WithdrawGasPayer internal realGasPayer;
  GatewayVmPayloadBuilder internal paidBuilder;

  address internal feeOracle;
  uint256 internal feeOraclePk;
  address internal spender;
  address internal spenderAlias;
  bytes internal gatewayDepository;
  uint256 internal gatewayTokenId;

  function setUp() public override {
    super.setUp();

    (feeOracle, feeOraclePk) = makeAddrAndKey("gateway-fee-oracle");
    spender = makeAddr("gateway-withdrawer");
    spenderAlias = Utils.generateAddress(
      SPENDER_CHAIN_ID,
      abi.encodePacked(spender)
    );
    gatewayDepository = abi.encodePacked(evmDestinationDepository);

    realGasPayer = new WithdrawGasPayer(address(hub), feeOracle);
    paidBuilder = new GatewayVmPayloadBuilder(
      address(config),
      address(realGasPayer)
    );

    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.startPrank(owner);
    hub.grantRole(operatorRole, owner);
    hub.grantRole(operatorRole, address(realGasPayer));
    hub.grantRole(operatorRole, address(allocator));
    allocator.setPayloadBuilder(
      CHAIN_ID,
      gatewayDepository,
      address(paidBuilder)
    );
    vm.stopPrank();

    BuildPayloadParams memory params = _params();
    gatewayTokenId = Utils.generateTokenId(CHAIN_ID, params.currency);
  }

  function test_withdrawerPrepaysCircleFeeBeforeAllocatorSubmission() public {
    BuildPayloadParams memory params = _params();
    RelayAllocator.WithdrawRequest memory request = _withdrawRequest(params);

    vm.prank(owner);
    hub.mint(spenderAlias, gatewayTokenId, params.amount + PAID_GAS);

    bytes32 withdrawParamsHash = realGasPayer.hashWithdrawParams(
      CHAIN_ID,
      gatewayDepository,
      params
    );
    realGasPayer.payGas(
      request,
      params.currency,
      PAID_GAS,
      PayGasSig.sign(
        feeOraclePk,
        realGasPayer,
        request,
        params.currency,
        PAID_GAS
      )
    );

    assertEq(realGasPayer.gasPayments(withdrawParamsHash), PAID_GAS);
    assertEq(realGasPayer.gasPayers(withdrawParamsHash), spenderAlias);
    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), params.amount);

    vm.prank(spender);
    bytes32 requestHash = allocator.submitWithdrawRequest(request);

    assertEq(hub.balanceOf(spenderAlias, gatewayTokenId), 0);
    GatewayVmPayload memory payload = abi.decode(
      allocator.payloads(requestHash),
      (GatewayVmPayload)
    );
    assertEq(payload.burnIntent.maxFee, PAID_GAS);
  }

  function _withdrawRequest(
    BuildPayloadParams memory params
  ) internal view returns (RelayAllocator.WithdrawRequest memory request) {
    return
      RelayAllocator.WithdrawRequest({
        chainId: CHAIN_ID,
        depository: gatewayDepository,
        currency: params.currency,
        amount: params.amount,
        spenderChainId: SPENDER_CHAIN_ID,
        spender: abi.encodePacked(spender),
        receiver: params.receiver,
        data: params.data,
        nonce: bytes32(params.nonce)
      });
  }
}

contract GatewayVmPayloadBuilderHashesToSignTest is
  GatewayVmPayloadBuilderBase
{
  function test_returnsCircleAndEvmExecutionDigestsInOrder() public view {
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      _params()
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );
    CallRequest memory request = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );

    bytes32[] memory hashes = builder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      encodedPayload
    );
    bytes32 destinationDomainSeparator = Eip712.domainSeparator(
      "RelayGatewayDepository",
      "1",
      DESTINATION_EVM_CHAIN_ID,
      evmDestinationDepository
    );
    bytes32[] memory callHashes = new bytes32[](request.calls.length);
    for (uint256 i = 0; i < request.calls.length; ++i) {
      bytes32 dataHash = request.calls[i].dataHash;
      if (dataHash == bytes32(0)) {
        dataHash = keccak256(request.calls[i].data);
      }
      callHashes[i] = keccak256(
        abi.encode(
          evmBuilder.CALL_TYPEHASH(),
          request.calls[i].to,
          dataHash,
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );
    }
    bytes32 structHash = keccak256(
      abi.encode(
        evmBuilder.CALL_REQUEST_TYPEHASH(),
        request.transferSpecHash,
        keccak256(abi.encodePacked(callHashes)),
        request.nonce,
        request.expiration
      )
    );

    assertEq(hashes.length, 2);
    assertEq(hashes[0], CircleGatewayCodec.hashBurnIntent(payload.burnIntent));
    assertEq(hashes[1], Eip712.digest(destinationDomainSeparator, structHash));
  }

  function test_committedAndExecutableCallsHaveSameDigest() public view {
    GatewayVmPayload memory payload = _buildEvmPayload();
    CallRequest memory executable = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );
    CallRequest memory committed = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );
    committed.calls[0].dataHash = keccak256(executable.calls[0].data);
    committed.calls[0].data = "";

    bytes32 executableHash = evmBuilder.hashExecutionPayload(
      EVM_SUBCHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      abi.encode(executable)
    );
    bytes32 committedHash = evmBuilder.hashExecutionPayload(
      EVM_SUBCHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      abi.encode(committed)
    );

    assertEq(committedHash, executableHash);
  }

  function test_rejectsCallWithDataAndDataHash() public {
    GatewayVmPayload memory payload = _buildEvmPayload();
    CallRequest memory request = abi.decode(
      payload.executionPayload,
      (CallRequest)
    );
    request.calls[0].dataHash = keccak256(request.calls[0].data);

    vm.expectRevert(
      GatewayEthereumVmDestinationPayloadBuilder.AmbiguousCallData.selector
    );
    evmBuilder.hashExecutionPayload(
      EVM_SUBCHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      abi.encode(request)
    );
  }

  function test_hashesCommittedCallLikeGatewayDepository() public view {
    bytes32 transferSpecHash = keccak256("transfer-spec");
    bytes32 dataHash = keccak256("off-chain calldata");
    bytes32 depositoryCallTypehash = keccak256(
      "Call(address to,bytes data,uint256 value,bool allowFailure)"
    );
    bytes32 depositoryRequestTypehash = keccak256(
      "CallRequest(bytes32 transferSpecHash,Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );
    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: address(0xBEEF),
      data: "",
      dataHash: dataHash,
      value: 17,
      allowFailure: true
    });
    CallRequest memory request = CallRequest({
      transferSpecHash: transferSpecHash,
      calls: calls,
      nonce: 42,
      expiration: 1_000_000
    });

    bytes32 actual = evmBuilder.hashExecutionPayload(
      EVM_SUBCHAIN_ID,
      abi.encodePacked(evmDestinationDepository),
      abi.encode(request)
    );
    bytes32 callHash = keccak256(
      abi.encode(
        depositoryCallTypehash,
        calls[0].to,
        dataHash,
        calls[0].value,
        calls[0].allowFailure
      )
    );
    bytes32 structHash = keccak256(
      abi.encode(
        depositoryRequestTypehash,
        transferSpecHash,
        keccak256(abi.encodePacked(callHash)),
        request.nonce,
        request.expiration
      )
    );
    bytes32 domainSeparator = Eip712.domainSeparator(
      "RelayGatewayDepository",
      "1",
      DESTINATION_EVM_CHAIN_ID,
      evmDestinationDepository
    );

    assertEq(actual, Eip712.digest(domainSeparator, structHash));
  }

  function test_returnsGatewayMetadata() public view {
    assertEq(builder.curve(), "Ecdsa/Eddsa");
    assertEq(builder.family(), "gateway-vm");
  }
}

contract GatewayVmPayloadBuilderMultiVmRoutingTest is
  GatewayVmPayloadBuilderBase
{
  uint32 internal constant SOLANA_DESTINATION_DOMAIN = 5;
  string internal constant SOLANA_CHAIN_ID = "solana";
  bytes32 internal constant SOLANA_DEPOSITORY =
    0x1111111111111111111111111111111111111111111111111111111111111111;
  bytes32 internal constant SOLANA_RECEIVER =
    0x2222222222222222222222222222222222222222222222222222222222222222;
  bytes32 internal constant SOLANA_MINTER =
    0x3333333333333333333333333333333333333333333333333333333333333333;
  bytes32 internal constant SOLANA_USDC =
    0x4444444444444444444444444444444444444444444444444444444444444444;

  MockSolanaGatewayDestinationPayloadBuilder internal solanaBuilder;

  function setUp() public override {
    super.setUp();
    solanaBuilder = new MockSolanaGatewayDestinationPayloadBuilder();
    bytes32[] memory keys = new bytes32[](4);
    bytes32[] memory values = new bytes32[](4);
    keys[0] = builder.getDomainTokenKey(SOLANA_CHAIN_ID);
    values[0] = SOLANA_USDC;
    keys[1] = builder.getDestinationBuilderKey(SOLANA_CHAIN_ID);
    values[1] = _encodeEvmAddress(address(solanaBuilder));
    keys[2] = builder.getDestinationDepositoryKey(SOLANA_CHAIN_ID);
    values[2] = SOLANA_DEPOSITORY;
    keys[3] = builder.getCircleDomainKey(SOLANA_CHAIN_ID);
    values[3] = bytes32(uint256(SOLANA_DESTINATION_DOMAIN));

    vm.prank(owner);
    config.setConfigValues(keys, values);
  }

  function test_routesSameGatewayChainToSolanaStyleDepository() public view {
    BuildPayloadParams memory params = _params();
    params.receiver = abi.encodePacked(SOLANA_RECEIVER);
    params.data = abi.encode(
      GatewayVmPayloadData({
        allocator: gatewayAllocator,
        destinationChainId: SOLANA_CHAIN_ID,
        maxBlockHeight: MAX_BLOCK_HEIGHT,
        destinationData: hex"1234"
      })
    );
    bytes memory encodedPayload = builder.buildPayload(
      CHAIN_ID,
      abi.encodePacked(bytes32(uint256(123))),
      params
    );
    GatewayVmPayload memory payload = abi.decode(
      encodedPayload,
      (GatewayVmPayload)
    );

    assertEq(
      payload.burnIntent.spec.sourceDepositor,
      _encodeEvmAddress(gatewayAllocator)
    );
    assertEq(payload.burnIntent.spec.destinationContract, SOLANA_MINTER);
    assertEq(payload.burnIntent.spec.destinationToken, SOLANA_USDC);
    assertEq(payload.burnIntent.spec.destinationRecipient, SOLANA_DEPOSITORY);
    assertEq(payload.burnIntent.spec.destinationCaller, SOLANA_DEPOSITORY);

    MockSolanaExecutionRequest memory execution = abi.decode(
      payload.executionPayload,
      (MockSolanaExecutionRequest)
    );
    assertEq(
      execution.transferSpecHash,
      CircleGatewayCodec.hashTransferSpec(payload.burnIntent.spec)
    );
    assertEq(execution.receiver, abi.encodePacked(SOLANA_RECEIVER));
    assertEq(execution.expiration, block.timestamp + EXPIRATION_DELAY);
    assertEq(execution.data, hex"1234");

    bytes32[] memory hashes = builder.hashesToSign(
      CHAIN_ID,
      abi.encodePacked(SOLANA_DEPOSITORY),
      encodedPayload
    );
    assertEq(hashes[0], CircleGatewayCodec.hashBurnIntent(payload.burnIntent));
    assertEq(
      hashes[1],
      keccak256(
        abi.encode(
          SOLANA_CHAIN_ID,
          abi.encodePacked(SOLANA_DEPOSITORY),
          payload.executionPayload
        )
      )
    );
  }
}

contract GatewayEthereumVmDestinationPayloadBuilderNonceTest is
  GatewayVmPayloadBuilderBase
{
  function _executionParams()
    internal
    view
    returns (GatewayExecutionParams memory)
  {
    return
      GatewayExecutionParams({
        destinationChainId: EVM_SUBCHAIN_ID,
        transferSpecHash: keccak256("transfer spec"),
        destinationToken: _encodeEvmAddress(destinationUsdc),
        depository: abi.encodePacked(
          _encodeEvmAddress(evmDestinationDepository)
        ),
        receiver: abi.encodePacked(receiver),
        amount: 1_000_000,
        nonce: 123,
        expiration: block.timestamp + EXPIRATION_DELAY,
        data: ""
      });
  }

  function _nonceOf(
    GatewayEthereumVmDestinationPayloadBuilder target,
    GatewayExecutionParams memory params
  ) internal view returns (uint256) {
    return
      abi.decode(target.buildExecutionPayload(params), (CallRequest)).nonce;
  }

  function test_derivesNonceFromBlockBuilderAndParams() public view {
    GatewayExecutionParams memory params = _executionParams();

    uint256 expectedNonce = uint256(
      keccak256(abi.encode(block.number, address(evmBuilder), params))
    );

    assertEq(_nonceOf(evmBuilder, params), expectedNonce);
    assertTrue(_nonceOf(evmBuilder, params) != params.nonce);
  }

  function test_derivesSameNonceWithinTheSameBlock() public view {
    GatewayExecutionParams memory params = _executionParams();

    assertEq(_nonceOf(evmBuilder, params), _nonceOf(evmBuilder, params));
  }

  function test_derivesDifferentNonceAcrossBlocks() public {
    GatewayExecutionParams memory params = _executionParams();
    uint256 first = _nonceOf(evmBuilder, params);

    vm.roll(block.number + 1);

    // A rebuild of the same request in a later block yields a fresh nonce
    assertTrue(_nonceOf(evmBuilder, params) != first);
  }

  function test_derivesDifferentNoncePerRequestNonce() public view {
    GatewayExecutionParams memory params = _executionParams();
    uint256 first = _nonceOf(evmBuilder, params);

    params.nonce = 124;

    assertTrue(_nonceOf(evmBuilder, params) != first);
  }

  function test_nonceCommitsToDestinationChainIdAndDepository() public view {
    GatewayExecutionParams memory params = _executionParams();
    uint256 base = _nonceOf(evmBuilder, params);

    GatewayExecutionParams memory otherChain = _executionParams();
    otherChain.destinationChainId = "10";
    assertTrue(_nonceOf(evmBuilder, otherChain) != base);

    GatewayExecutionParams memory otherDepository = _executionParams();
    otherDepository.depository = abi.encodePacked(_encodeEvmAddress(receiver));
    assertTrue(_nonceOf(evmBuilder, otherDepository) != base);
  }

  function test_nonceCommitsToTransferSpecHash() public view {
    GatewayExecutionParams memory params = _executionParams();
    uint256 base = _nonceOf(evmBuilder, params);

    params.transferSpecHash = keccak256("other transfer spec");

    assertTrue(_nonceOf(evmBuilder, params) != base);
  }

  function test_nonceCommitsToBuilderAddress() public {
    GatewayExecutionParams memory params = _executionParams();
    GatewayEthereumVmDestinationPayloadBuilder otherBuilder = new GatewayEthereumVmDestinationPayloadBuilder(
        address(config)
      );

    assertTrue(_nonceOf(otherBuilder, params) != _nonceOf(evmBuilder, params));
  }
}
