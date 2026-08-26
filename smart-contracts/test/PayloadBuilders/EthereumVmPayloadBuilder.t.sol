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
import {MyToken} from "../../contracts/test-utils/MyToken.sol";
import {
  EthereumVmPayloadBuilder,
  CallRequest,
  Call,
  RoutedWithdrawalData
} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {
  Call as RouterCall,
  IMulticallRouter
} from "../../contracts/routers/IMulticallRouter.sol";
import {MulticallRouter} from "../../contracts/routers/MulticallRouter.sol";

/// @notice Port of test/PayloadBuilders/EthereumVmPayloadBuilder.ts.
abstract contract EthereumVmPayloadBuilderBase is BaseTest {
  uint256 internal constant EXPIRATION_DELAY_SECONDS = 10 * 24 * 60 * 60;
  uint256 internal constant EXPIRATION_TOLERANCE_SECONDS = 10;

  address internal depositoryAddr;
  address internal receiverAddr;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  Config internal config;
  EthereumVmPayloadBuilder internal payloadBuilder;
  MyToken internal myToken;

  function setUp() public virtual override {
    super.setUp();
    depositoryAddr = otherAccounts[0];
    receiverAddr = otherAccounts[1];

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0));
    config = new Config(address(allocator));
    payloadBuilder = new EthereumVmPayloadBuilder(address(config));
    myToken = new MyToken();

    bytes32 expirationKey = payloadBuilder.getExpirationKey();
    vm.prank(owner);
    config.setConfigValue(expirationKey, bytes32(EXPIRATION_DELAY_SECONDS));
  }

  function _addrBytes(address a) internal pure returns (bytes memory) {
    return abi.encodePacked(a);
  }
}

contract EthereumVmPayloadBuilderBuildPayloadTest is
  EthereumVmPayloadBuilderBase
{
  function test_buildsPayloadForNativeCurrency() public {
    uint256 amount = 0.1 ether;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: amount,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    uint256 nowTs = block.timestamp;
    bytes memory payload = payloadBuilder.buildPayload(
      "ethereum-mainnet",
      _addrBytes(depositoryAddr),
      params
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertGe(
      decoded.expiration,
      nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
    );
    assertLe(
      decoded.expiration,
      nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
    );
    assertEq(decoded.calls.length, 1);
    Call memory c = decoded.calls[0];
    assertEq(c.to, receiverAddr);
    assertEq(c.value, amount);
    assertFalse(c.allowFailure);

    uint256 balBefore = receiverAddr.balance;
    vm.deal(depositoryAddr, amount);
    vm.prank(depositoryAddr);
    (bool ok, ) = c.to.call{value: c.value}(c.data);
    require(ok, "send failed");
    assertEq(receiverAddr.balance, balBefore + amount);
  }

  function test_derivesNonceFromBuilderChainDepositoryAndParams() public {
    uint256 amount = 0.1 ether;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: amount,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    uint256 blockNumber = block.number;
    bytes memory payload = payloadBuilder.buildPayload(
      "ethereum-mainnet",
      _addrBytes(depositoryAddr),
      params
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    uint256 expectedNonce = uint256(
      keccak256(
        abi.encode(
          blockNumber,
          address(payloadBuilder),
          "ethereum-mainnet",
          _addrBytes(depositoryAddr),
          params
        )
      )
    );
    assertEq(decoded.nonce, expectedNonce);
    assertTrue(decoded.nonce != 1);
  }

  function test_derivesSameNonceWithinTheSameBlock() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    CallRequest memory first = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );
    CallRequest memory second = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    assertEq(second.nonce, first.nonce);
  }

  function test_derivesDifferentNonceAcrossBlocks() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    CallRequest memory first = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    vm.roll(block.number + 1);

    CallRequest memory second = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    // A rebuild of the same request in a later block yields a fresh nonce
    assertTrue(second.nonce != first.nonce);
  }

  function test_derivesDifferentNoncePerRequestNonce() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    CallRequest memory first = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    params.nonce = 2;
    CallRequest memory second = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    assertTrue(second.nonce != first.nonce);
  }

  function test_nonceCommitsToChainIdAndDepository() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    CallRequest memory base = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );
    CallRequest memory otherChain = abi.decode(
      payloadBuilder.buildPayload(
        "base-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );
    CallRequest memory otherDepository = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(receiverAddr),
        params
      ),
      (CallRequest)
    );

    assertTrue(otherChain.nonce != base.nonce);
    assertTrue(otherDepository.nonce != base.nonce);
  }

  function test_nonceCommitsToBuilderAddress() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    EthereumVmPayloadBuilder otherBuilder = new EthereumVmPayloadBuilder(
      address(config)
    );

    CallRequest memory base = abi.decode(
      payloadBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );
    CallRequest memory other = abi.decode(
      otherBuilder.buildPayload(
        "ethereum-mainnet",
        _addrBytes(depositoryAddr),
        params
      ),
      (CallRequest)
    );

    assertTrue(other.nonce != base.nonce);
  }

  function test_buildsPayloadForErc20Token() public {
    uint256 amount = 1337 * 1e18;
    myToken.mintFor(amount, depositoryAddr);

    uint256 nowTs = block.timestamp;
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(myToken)),
      amount: amount,
      receiver: _addrBytes(receiverAddr),
      nonce: 3,
      data: ""
    });

    bytes memory payload = payloadBuilder.buildPayload(
      "ethereum-mainnet",
      _addrBytes(depositoryAddr),
      params
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertGe(
      decoded.expiration,
      nowTs + EXPIRATION_DELAY_SECONDS - EXPIRATION_TOLERANCE_SECONDS
    );
    assertLe(
      decoded.expiration,
      nowTs + EXPIRATION_DELAY_SECONDS + EXPIRATION_TOLERANCE_SECONDS
    );
    assertEq(decoded.calls.length, 1);
    Call memory c = decoded.calls[0];
    assertEq(c.to, address(myToken));
    assertEq(c.value, 0);
    assertFalse(c.allowFailure);

    uint256 balBefore = myToken.balanceOf(receiverAddr);
    vm.prank(depositoryAddr);
    (bool ok, ) = c.to.call(c.data);
    require(ok, "transfer call failed");
    assertEq(myToken.balanceOf(receiverAddr), balBefore + amount);
  }

  function test_revertsWhenReceiverIsNot20Bytes() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 1,
      receiver: hex"1234",
      nonce: 1,
      data: ""
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.InvalidReceiverLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(
      "ethereum-mainnet",
      _addrBytes(depositoryAddr),
      params
    );
  }

  function test_revertsWhenCurrencyIsNeitherEmptyNor20Bytes() public {
    BuildPayloadParams memory params = BuildPayloadParams({
      currency: hex"1234",
      amount: 1,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: ""
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.InvalidCurrencyLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(
      "ethereum-mainnet",
      _addrBytes(depositoryAddr),
      params
    );
  }
}

contract EthereumVmPayloadBuilderHashesToSignTest is
  EthereumVmPayloadBuilderBase
{
  function _setEvmChainId(string memory chainId, uint256 evmChainId) internal {
    bytes32 key = payloadBuilder.getEvmChainIdKey(chainId);
    vm.prank(owner);
    config.setConfigValue(key, bytes32(evmChainId));
  }

  function test_hashesPayloadCorrectlyUsingEip712() public {
    string memory chainId = "ethereum-mainnet";
    _setEvmChainId(chainId, 1);

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(0)),
      amount: 0.1 ether,
      receiver: _addrBytes(receiverAddr),
      nonce: 4,
      data: ""
    });
    bytes memory payload = payloadBuilder.buildPayload(
      chainId,
      _addrBytes(depositoryAddr),
      params
    );

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      chainId,
      _addrBytes(depositoryAddr),
      payload
    );

    CallRequest memory req = abi.decode(payload, (CallRequest));

    // Reconstruct the EIP-712 hash exactly as the contract does.
    bytes32 domainSep = Eip712.domainSeparator(
      "RelayDepository",
      "1",
      1,
      depositoryAddr
    );
    bytes32 CALL_TYPEHASH = keccak256(
      "Call(address to,bytes data,uint256 value,bool allowFailure)"
    );
    bytes32 CALL_REQUEST_TYPEHASH = keccak256(
      "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );
    bytes32[] memory callHashes = new bytes32[](req.calls.length);
    for (uint256 i = 0; i < req.calls.length; i++) {
      callHashes[i] = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          req.calls[i].to,
          keccak256(req.calls[i].data),
          req.calls[i].value,
          req.calls[i].allowFailure
        )
      );
    }
    bytes32 structHash = keccak256(
      abi.encode(
        CALL_REQUEST_TYPEHASH,
        keccak256(abi.encodePacked(callHashes)),
        req.nonce,
        req.expiration
      )
    );
    bytes32 expected = keccak256(
      abi.encodePacked("\x19\x01", domainSep, structHash)
    );

    assertEq(hashes[0], expected);
  }

  function test_namespacesConfigKeyForEvmChainIdLookups() public view {
    string memory chainId = "ethereum-mainnet";
    bytes32 key = payloadBuilder.getEvmChainIdKey(chainId);
    bytes32 expected = keccak256(
      abi.encodePacked(keccak256("ETHEREUM_VM_CHAIN_ID"), chainId)
    );
    assertEq(key, expected);
  }

  function test_namespacesConfigKeyForExpirationLookups() public view {
    assertEq(
      payloadBuilder.getExpirationKey(),
      keccak256("ETHEREUM_VM_EXPIRATION")
    );
  }

  function test_revertsIfChainIdIsNotConfigured() public {
    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: address(0),
      data: "",
      dataHash: bytes32(0),
      value: 0,
      allowFailure: false
    });
    CallRequest memory req = CallRequest({
      calls: calls,
      nonce: 1,
      expiration: 2
    });
    bytes memory payload = abi.encode(req);

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getEvmChainIdKey("missing-chain-id")
      )
    );
    payloadBuilder.hashesToSign(
      "missing-chain-id",
      _addrBytes(address(0x1111111111111111111111111111111111111111)),
      payload
    );
  }

  function test_revertsIfDepositoryIsNot20Bytes() public {
    _setEvmChainId("ethereum-mainnet", 1);

    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: address(0),
      data: "",
      dataHash: bytes32(0),
      value: 0,
      allowFailure: false
    });
    CallRequest memory req = CallRequest({
      calls: calls,
      nonce: 1,
      expiration: 2
    });
    bytes memory payload = abi.encode(req);

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.InvalidDepositoryLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.hashesToSign("ethereum-mainnet", hex"1234", payload);
  }
}

contract EthereumVmPayloadBuilderMetadataTest is EthereumVmPayloadBuilderBase {
  function test_returnsExpectedCurve() public view {
    assertEq(payloadBuilder.curve(), "Ecdsa");
  }

  function test_returnsExpectedFamily() public view {
    assertEq(payloadBuilder.family(), "ethereum-vm");
  }
}

contract EthereumVmPayloadBuilderRoutedTest is EthereumVmPayloadBuilderBase {
  string internal constant CHAIN_ID = "ethereum-mainnet";

  MulticallRouter internal router;

  function setUp() public virtual override {
    super.setUp();

    router = new MulticallRouter(owner);
    // Cache the role: reading it inside the call args would consume the prank
    bytes32 depositoryRole = router.DEPOSITORY_ROLE();
    vm.prank(owner);
    router.grantRole(depositoryRole, depositoryAddr);

    bytes32 allowedKey = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      depositoryAddr,
      address(router)
    );
    vm.prank(owner);
    config.setConfigValue(allowedKey, bytes32(uint256(1)));
  }

  /// @notice The router calldata the withdrawal commits to
  function _multicallData(
    RouterCall[] memory calls
  ) internal pure returns (bytes memory) {
    return abi.encodeCall(IMulticallRouter.multicall, (calls));
  }

  function _routedData(
    address routerAddress,
    RouterCall[] memory calls
  ) internal pure returns (bytes memory) {
    return
      abi.encode(
        RoutedWithdrawalData({
          version: 1,
          router: routerAddress,
          dataHash: keccak256(_multicallData(calls))
        })
      );
  }

  function _singleCall(
    address to,
    bytes memory data,
    uint256 value
  ) internal pure returns (RouterCall[] memory calls) {
    calls = new RouterCall[](1);
    calls[0] = RouterCall({
      to: to,
      data: data,
      value: value,
      allowFailure: false
    });
  }

  function _routedParams(
    address currency,
    uint256 amount,
    bytes memory data
  ) internal view returns (BuildPayloadParams memory params) {
    params = BuildPayloadParams({
      currency: _addrBytes(currency),
      amount: amount,
      receiver: _addrBytes(address(router)),
      nonce: 1,
      data: data
    });
  }

  /// @notice Substitutes the commitment preimage into a built payload, producing the
  /// request the executor actually submits to the depository
  function _toExecutableRequest(
    CallRequest memory request,
    bytes memory multicallData
  ) internal pure returns (CallRequest memory executable) {
    executable = request;
    executable.calls[1].data = multicallData;
    executable.calls[1].dataHash = bytes32(0);
  }

  function test_routedBuildsTransferAndCommitmentForErc20() public {
    uint256 amount = 1337 * 1e18;
    RouterCall[] memory innerCalls = _singleCall(
      address(myToken),
      abi.encodeWithSignature(
        "transfer(address,uint256)",
        receiverAddr,
        amount
      ),
      0
    );

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(myToken),
        amount,
        _routedData(address(router), innerCalls)
      )
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertEq(decoded.calls.length, 2);

    assertEq(decoded.calls[0].to, address(myToken));
    assertEq(
      decoded.calls[0].data,
      abi.encodeWithSignature(
        "transfer(address,uint256)",
        address(router),
        amount
      )
    );
    assertEq(decoded.calls[0].dataHash, bytes32(0));
    assertEq(decoded.calls[0].value, 0);
    assertFalse(decoded.calls[0].allowFailure);

    assertEq(decoded.calls[1].to, address(router));
    assertEq(decoded.calls[1].data, bytes(""));
    assertEq(decoded.calls[1].dataHash, keccak256(_multicallData(innerCalls)));
    assertEq(decoded.calls[1].value, 0);
    assertFalse(decoded.calls[1].allowFailure);
  }

  function test_routedBuildsTransferAndCommitmentForNativeCurrency() public {
    uint256 amount = 0.1 ether;
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", amount);

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(0),
        amount,
        _routedData(address(router), innerCalls)
      )
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertEq(decoded.calls.length, 2);

    assertEq(decoded.calls[0].to, address(router));
    assertEq(decoded.calls[0].data, bytes(""));
    assertEq(decoded.calls[0].dataHash, bytes32(0));
    assertEq(decoded.calls[0].value, amount);
    assertFalse(decoded.calls[0].allowFailure);

    assertEq(decoded.calls[1].to, address(router));
    assertEq(decoded.calls[1].data, bytes(""));
    assertEq(decoded.calls[1].dataHash, keccak256(_multicallData(innerCalls)));
    assertEq(decoded.calls[1].value, 0);
    assertFalse(decoded.calls[1].allowFailure);
  }

  /// @notice Supplying the preimage must not change the digest the allocator signed,
  /// otherwise the depository would reject every routed withdrawal
  function test_routedCommittedPayloadHashesLikeExecutablePayload() public {
    bytes32 key = payloadBuilder.getEvmChainIdKey(CHAIN_ID);
    vm.prank(owner);
    config.setConfigValue(key, bytes32(uint256(1)));

    RouterCall[] memory innerCalls = _singleCall(
      address(myToken),
      abi.encodeWithSignature(
        "transfer(address,uint256)",
        receiverAddr,
        uint256(1)
      ),
      0
    );
    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(myToken),
        1,
        _routedData(address(router), innerCalls)
      )
    );

    bytes32[] memory committedHashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      payload
    );
    bytes32[] memory executableHashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      abi.encode(
        _toExecutableRequest(
          abi.decode(payload, (CallRequest)),
          _multicallData(innerCalls)
        )
      )
    );

    assertEq(committedHashes.length, 1);
    assertEq(committedHashes[0], executableHashes[0]);
  }

  function test_routedPayloadExecutesAgainstRouter() public {
    uint256 amount = 1000 * 1e18;
    myToken.mintFor(amount, depositoryAddr);

    // Oracle-style bundle: the partial transfer leaves a residual that the
    // bundled sweep call cleans up
    address[] memory sweepCurrencies = new address[](2);
    sweepCurrencies[0] = address(myToken);
    sweepCurrencies[1] = address(0);

    RouterCall[] memory innerCalls = new RouterCall[](2);
    innerCalls[0] = RouterCall({
      to: address(myToken),
      data: abi.encodeWithSignature(
        "transfer(address,uint256)",
        receiverAddr,
        700 * 1e18
      ),
      value: 0,
      allowFailure: false
    });
    innerCalls[1] = RouterCall({
      to: address(router),
      data: abi.encodeCall(
        MulticallRouter.sweep,
        (sweepCurrencies, receiverAddr)
      ),
      value: 0,
      allowFailure: false
    });

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(myToken),
        amount,
        _routedData(address(router), innerCalls)
      )
    );
    CallRequest memory executable = _toExecutableRequest(
      abi.decode(payload, (CallRequest)),
      _multicallData(innerCalls)
    );

    vm.startPrank(depositoryAddr);
    for (uint256 i = 0; i < executable.calls.length; ++i) {
      (bool ok, ) = executable.calls[i].to.call{
        value: executable.calls[i].value
      }(executable.calls[i].data);
      require(ok, "call failed");
    }
    vm.stopPrank();

    assertEq(myToken.balanceOf(receiverAddr), amount);
    assertEq(myToken.balanceOf(address(router)), 0);
  }

  function test_routedPayloadExecutesAgainstRouterForNativeCurrency() public {
    uint256 amount = 0.5 ether;
    vm.deal(depositoryAddr, amount);

    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", amount);

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(0),
        amount,
        _routedData(address(router), innerCalls)
      )
    );
    CallRequest memory executable = _toExecutableRequest(
      abi.decode(payload, (CallRequest)),
      _multicallData(innerCalls)
    );

    uint256 balBefore = receiverAddr.balance;
    vm.startPrank(depositoryAddr);
    for (uint256 i = 0; i < executable.calls.length; ++i) {
      (bool ok, ) = executable.calls[i].to.call{
        value: executable.calls[i].value
      }(executable.calls[i].data);
      require(ok, "call failed");
    }
    vm.stopPrank();

    assertEq(receiverAddr.balance, balBefore + amount);
    assertEq(address(router).balance, 0);
  }

  function test_routedRevertsWhenVersionUnsupported() public {
    bytes memory data = abi.encode(
      RoutedWithdrawalData({
        version: 3,
        router: address(router),
        dataHash: keccak256("bundle")
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.UnsupportedRoutedDataVersion.selector,
        uint8(3)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, data)
    );
  }

  function test_routedRevertsWhenVersionIsZero() public {
    bytes memory data = abi.encode(
      RoutedWithdrawalData({
        version: 0,
        router: address(router),
        dataHash: keccak256("bundle")
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.UnsupportedRoutedDataVersion.selector,
        uint8(0)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, data)
    );
  }

  function test_routedRevertsWhenCallsHashIsZero() public {
    bytes memory data = abi.encode(
      RoutedWithdrawalData({
        version: 1,
        router: address(router),
        dataHash: bytes32(0)
      })
    );

    vm.expectRevert(EthereumVmPayloadBuilder.EmptyRoutedCallsHash.selector);
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, data)
    );
  }

  function test_routedRevertsWhenCallsHashIsEmptyCalldata() public {
    // Its executable twin is a bare call, which the router's `receive`
    // accepts, so the withdrawal would settle with no bundle having run
    bytes memory data = abi.encode(
      RoutedWithdrawalData({
        version: 1,
        router: address(router),
        dataHash: keccak256("")
      })
    );

    vm.expectRevert(EthereumVmPayloadBuilder.EmptyRoutedCallsHash.selector);
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, data)
    );
  }

  function test_routedFundsTheReceiverWhenItIsNotTheRouter() public {
    // A withdrawal may fund a smart wallet and have the router act on it
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    BuildPayloadParams memory params = BuildPayloadParams({
      currency: _addrBytes(address(myToken)),
      amount: 7,
      receiver: _addrBytes(receiverAddr),
      nonce: 1,
      data: _routedData(address(router), innerCalls)
    });

    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      params
    );
    CallRequest memory decoded = abi.decode(payload, (CallRequest));

    assertEq(decoded.calls.length, 2);
    assertEq(
      decoded.calls[0].data,
      abi.encodeWithSignature(
        "transfer(address,uint256)",
        receiverAddr,
        uint256(7)
      )
    );
    assertEq(decoded.calls[1].to, address(router));
  }

  function test_routedRevertsWhenDataIsMalformed() public {
    vm.expectRevert();
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, hex"deadbeef")
    );
  }

  function test_routedRevertsWhenRouterNotAllowlisted() public {
    address unknownRouter = otherAccounts[3];
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    // An unset allowlist key fails closed inside Config
    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getRouterAllowedKey(
          CHAIN_ID,
          depositoryAddr,
          unknownRouter
        )
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(unknownRouter, innerCalls))
    );
  }

  function test_routedRevertsWhenRouterDisabled() public {
    bytes32 allowedKey = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      depositoryAddr,
      address(router)
    );
    vm.prank(owner);
    config.setConfigValue(allowedKey, bytes32(0));

    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.RouterNotAllowed.selector,
        address(router)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(address(router), innerCalls))
    );
  }

  function test_routedRevertsWhenAllowlistValueIsNotOne() public {
    bytes32 allowedKey = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      depositoryAddr,
      address(router)
    );
    vm.prank(owner);
    config.setConfigValue(allowedKey, bytes32(uint256(2)));

    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.RouterNotAllowed.selector,
        address(router)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(address(router), innerCalls))
    );
  }

  function test_routedRevertsWhenRouterAllowedOnDifferentChain() public {
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getRouterAllowedKey(
          "base",
          depositoryAddr,
          address(router)
        )
      )
    );
    payloadBuilder.buildPayload(
      "base",
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(address(router), innerCalls))
    );
  }

  function test_routedRevertsWhenRouterAllowedForDifferentDepository() public {
    address wrongDepository = otherAccounts[2];
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        Config.ConfigValueNotSet.selector,
        payloadBuilder.getRouterAllowedKey(
          CHAIN_ID,
          wrongDepository,
          address(router)
        )
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(wrongDepository),
      _routedParams(address(0), 1, _routedData(address(router), innerCalls))
    );
  }

  function test_routedRevertsWhenDepositoryIsNot20Bytes() public {
    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        EthereumVmPayloadBuilder.InvalidDepositoryLength.selector,
        uint256(2)
      )
    );
    payloadBuilder.buildPayload(
      CHAIN_ID,
      hex"1234",
      _routedParams(address(0), 1, _routedData(address(router), innerCalls))
    );
  }

  function test_routedNonceCommitsToRoutedData() public {
    RouterCall[] memory innerCallsA = _singleCall(
      receiverAddr,
      hex"deadbeef",
      0
    );
    RouterCall[] memory innerCallsB = _singleCall(
      receiverAddr,
      hex"c0fe5632",
      0
    );

    bytes memory payloadA = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(address(router), innerCallsA))
    );
    bytes memory payloadB = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(address(0), 1, _routedData(address(router), innerCallsB))
    );

    CallRequest memory decodedA = abi.decode(payloadA, (CallRequest));
    CallRequest memory decodedB = abi.decode(payloadB, (CallRequest));

    // Same receiver, currency, and amount — only the routed data differs
    assertTrue(decodedA.nonce != decodedB.nonce);
  }

  function test_routedPayloadHashesCorrectlyUsingEip712() public {
    bytes32 key = payloadBuilder.getEvmChainIdKey(CHAIN_ID);
    vm.prank(owner);
    config.setConfigValue(key, bytes32(uint256(1)));

    RouterCall[] memory innerCalls = _singleCall(receiverAddr, "", 0);
    bytes memory payload = payloadBuilder.buildPayload(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      _routedParams(
        address(0),
        0.1 ether,
        _routedData(address(router), innerCalls)
      )
    );

    bytes32[] memory hashes = payloadBuilder.hashesToSign(
      CHAIN_ID,
      _addrBytes(depositoryAddr),
      payload
    );

    CallRequest memory req = abi.decode(payload, (CallRequest));
    bytes32 domainSep = Eip712.domainSeparator(
      "RelayDepository",
      "1",
      1,
      depositoryAddr
    );
    bytes32[] memory callHashes = new bytes32[](req.calls.length);
    for (uint256 i = 0; i < req.calls.length; i++) {
      bytes32 dataHash = req.calls[i].dataHash == bytes32(0)
        ? keccak256(req.calls[i].data)
        : req.calls[i].dataHash;
      callHashes[i] = keccak256(
        abi.encode(
          payloadBuilder.CALL_TYPEHASH(),
          req.calls[i].to,
          dataHash,
          req.calls[i].value,
          req.calls[i].allowFailure
        )
      );
    }
    bytes32 structHash = keccak256(
      abi.encode(
        payloadBuilder.CALL_REQUEST_TYPEHASH(),
        keccak256(abi.encodePacked(callHashes)),
        req.nonce,
        req.expiration
      )
    );
    bytes32 expected = keccak256(
      abi.encodePacked("\x19\x01", domainSep, structHash)
    );

    assertEq(hashes.length, 1);
    assertEq(hashes[0], expected);
  }

  function test_namespacesConfigKeyForRouterAllowlist() public view {
    bytes32 key = payloadBuilder.getRouterAllowedKey(
      CHAIN_ID,
      depositoryAddr,
      address(router)
    );
    bytes32 expected = keccak256(
      abi.encode(
        keccak256("ETHEREUM_VM_ROUTER_ALLOWED"),
        keccak256(bytes(CHAIN_ID)),
        depositoryAddr,
        address(router)
      )
    );
    assertEq(key, expected);
  }
}
