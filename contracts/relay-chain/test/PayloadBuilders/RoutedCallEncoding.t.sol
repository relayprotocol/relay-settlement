// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {
  Call,
  CallRequest,
  EthereumVmPayloadBuilder,
  RoutedWithdrawalData
} from "../../contracts/payload-builders/EthereumVmPayloadBuilder.sol";
import {
  Call as RouterCall,
  IMulticallRouter
} from "../../contracts/routers/IMulticallRouter.sol";
import {Utils} from "../../contracts/Utils.sol";
import {
  DepositoryCall,
  DepositoryCallRequest,
  DepositoryHashRef
} from "../utils/DepositoryHashRef.sol";
import {Eip712} from "../utils/Eip712.sol";

contract EthereumVmPayloadBuilderHarness is EthereumVmPayloadBuilder {
  constructor() EthereumVmPayloadBuilder(address(0)) {}

  function exposeHashCallRequest(
    CallRequest memory request,
    bytes32 domainSeparator
  ) external pure returns (bytes32) {
    return hashCallRequest(request, domainSeparator);
  }
}

/// @notice Committed CallRequest hashing and routed-data encoding checks
/// backing the SDK routed codec (packages/sdk/test/routed-calls.test.ts)
contract RoutedCallEncoding is Test {
  address internal constant ROUTER = 0x4444444444444444444444444444444444444444;
  address internal constant DEPOSITORY =
    0x5555555555555555555555555555555555555555;
  uint256 internal constant NONCE =
    0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767;
  uint256 internal constant EXPIRATION = 1774878936;

  EthereumVmPayloadBuilderHarness internal harness;

  function setUp() public {
    harness = new EthereumVmPayloadBuilderHarness();
  }

  /// @notice The inner bundle the router executes, i.e. the commitment preimage
  function _innerCalls() internal pure returns (RouterCall[] memory calls) {
    calls = new RouterCall[](3);
    calls[0] = RouterCall({
      to: 0x1111111111111111111111111111111111111111,
      data: hex"deadbeef0000000000000000000000000000000000000000000000000000000000000001",
      value: 123456789,
      allowFailure: true
    });
    calls[1] = RouterCall({
      to: 0x2222222222222222222222222222222222222222,
      data: hex"c0fe563200000000000000000000000000000000000000000000000000000000004c4b40",
      value: 0,
      allowFailure: false
    });
    calls[2] = RouterCall({
      to: 0x3333333333333333333333333333333333333333,
      data: hex"",
      value: 1000000000000000000,
      allowFailure: false
    });
  }

  /// @notice The router calldata the depository ultimately sends
  function _multicallData() internal pure returns (bytes memory) {
    return abi.encodeCall(IMulticallRouter.multicall, (_innerCalls()));
  }

  /// @notice The ERC-20 transfer funding the router, identical in both request forms
  function _transferCall() internal pure returns (Call memory) {
    return
      Call({
        to: 0x6666666666666666666666666666666666666666,
        data: abi.encodeWithSignature(
          "transfer(address,uint256)",
          ROUTER,
          uint256(1337 * 1e18)
        ),
        dataHash: bytes32(0),
        value: 0,
        allowFailure: false
      });
  }

  /// @notice The request the payload builder emits: the router call carries only a commitment
  function _committedRequest()
    internal
    pure
    returns (CallRequest memory request)
  {
    Call[] memory calls = new Call[](2);
    calls[0] = _transferCall();
    calls[1] = Call({
      to: ROUTER,
      data: bytes(""),
      dataHash: keccak256(_multicallData()),
      value: 0,
      allowFailure: false
    });

    request = CallRequest({calls: calls, nonce: NONCE, expiration: EXPIRATION});
  }

  /// @notice The request the executor submits, with the commitment preimage supplied
  function _executableRequest()
    internal
    pure
    returns (CallRequest memory request)
  {
    Call[] memory calls = new Call[](2);
    calls[0] = _transferCall();
    calls[1] = Call({
      to: ROUTER,
      data: _multicallData(),
      dataHash: bytes32(0),
      value: 0,
      allowFailure: false
    });

    request = CallRequest({calls: calls, nonce: NONCE, expiration: EXPIRATION});
  }

  function _domainSeparator() internal pure returns (bytes32) {
    return Utils.buildDomainSeparator("RelayDepository", "1", 8453, DEPOSITORY);
  }

  function testRoutedWithdrawalDataRoundtrip() public pure {
    bytes memory encoded = abi.encode(
      RoutedWithdrawalData({
        version: 1,
        router: ROUTER,
        dataHash: keccak256(_multicallData())
      })
    );

    // Keep in sync with packages/sdk/test/routed-calls.test.ts (same fixture)
    assertEq(
      keccak256(_multicallData()),
      bytes32(
        0xef4da15da66cc4e722d177a40f2c6fdafe93a4803f68cd6e6bac6b80d6c0ae17
      )
    );
    assertEq(
      keccak256(encoded),
      bytes32(
        0x0327bd943b2b64a89574a7661f64a5b71105d69f5bb57dfd44b0d58d390327a2
      )
    );

    RoutedWithdrawalData memory decoded = abi.decode(
      encoded,
      (RoutedWithdrawalData)
    );

    assertEq(decoded.version, 1);
    assertEq(decoded.router, ROUTER);
    assertEq(decoded.dataHash, keccak256(_multicallData()));
  }

  /// @notice The request the depository consumes, hashed by its own algorithm
  function _depositoryRequest()
    internal
    pure
    returns (DepositoryCallRequest memory request)
  {
    DepositoryCall[] memory calls = new DepositoryCall[](2);
    Call memory transfer = _transferCall();
    calls[0] = DepositoryCall({
      to: transfer.to,
      data: transfer.data,
      value: transfer.value,
      allowFailure: transfer.allowFailure
    });
    calls[1] = DepositoryCall({
      to: ROUTER,
      data: _multicallData(),
      value: 0,
      allowFailure: false
    });

    request = DepositoryCallRequest({
      calls: calls,
      nonce: NONCE,
      expiration: EXPIRATION
    });
  }

  /// @notice The digest the allocator signs must be the one the depository recomputes
  /// from the preimage
  function testCommittedRequestDigestMatchesDepositoryDigest() public view {
    bytes32 domainSeparator = _domainSeparator();

    // Against the depository's own hashing, not the builder's — otherwise both sides
    // of the assertion move together if the substitution rule ever changes
    assertEq(
      harness.exposeHashCallRequest(_committedRequest(), domainSeparator),
      DepositoryHashRef.hash(_depositoryRequest(), domainSeparator)
    );

    // The builder must also accept the executable form unchanged
    assertEq(
      harness.exposeHashCallRequest(_executableRequest(), domainSeparator),
      DepositoryHashRef.hash(_depositoryRequest(), domainSeparator)
    );
  }

  function testCommittedRequestDigest() public view {
    CallRequest memory request = _committedRequest();
    bytes32 domainSeparator = _domainSeparator();

    assertEq(
      domainSeparator,
      Eip712.domainSeparator("RelayDepository", "1", 8453, DEPOSITORY)
    );

    // Recompute the digest manually as an independent reference, substituting the
    // commitment exactly where the depository puts keccak256(call.data)
    bytes32[] memory callHashes = new bytes32[](request.calls.length);
    for (uint256 i = 0; i < request.calls.length; ++i) {
      bytes32 dataHash = request.calls[i].dataHash == bytes32(0)
        ? keccak256(request.calls[i].data)
        : request.calls[i].dataHash;
      callHashes[i] = keccak256(
        abi.encode(
          harness.CALL_TYPEHASH(),
          request.calls[i].to,
          dataHash,
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );
    }
    bytes32 structHash = keccak256(
      abi.encode(
        harness.CALL_REQUEST_TYPEHASH(),
        keccak256(abi.encodePacked(callHashes)),
        request.nonce,
        request.expiration
      )
    );

    assertEq(
      harness.exposeHashCallRequest(request, domainSeparator),
      Eip712.digest(domainSeparator, structHash)
    );

    // Keep in sync with packages/sdk/test/routed-calls.test.ts (same fixture)
    assertEq(
      harness.exposeHashCallRequest(request, domainSeparator),
      bytes32(
        0xcc7e1d7b168a0ac06417315f32576a393e96e064c5d528799d113c9f31106eb8
      )
    );
  }

  function testCommittedRequestEncoding() public pure {
    // Keep in sync with packages/sdk/test/routed-calls.test.ts (same fixture) — the
    // SDK decodes `allocator.payloads(...)`, so the two encoders must not drift
    assertEq(
      keccak256(abi.encode(_committedRequest())),
      keccak256(
        hex"000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000609400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f7670000000000000000000000000000000000000000000000000000000069ca80d8000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000666666666666666666666666666666666666666600000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000487a9a30453944000000000000000000000000000000000000000000000000000000000000000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000000a0ef4da15da66cc4e722d177a40f2c6fdafe93a4803f68cd6e6bac6b80d6c0ae17000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      )
    );
  }

  function testHashCallRequestRejectsCallWithBothDataAndCommitment() public {
    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: ROUTER,
      data: _multicallData(),
      dataHash: keccak256(_multicallData()),
      value: 0,
      allowFailure: false
    });

    CallRequest memory request = CallRequest({
      calls: calls,
      nonce: NONCE,
      expiration: EXPIRATION
    });

    vm.expectRevert(EthereumVmPayloadBuilder.AmbiguousCallData.selector);
    harness.exposeHashCallRequest(request, _domainSeparator());
  }
}
