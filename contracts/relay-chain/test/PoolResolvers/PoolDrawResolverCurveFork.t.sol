// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPayloadBuilder} from "../../contracts/RelayAllocator.sol";

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
  WithdrawRequest,
  WithdrawFee,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayExecutor} from "../../contracts/RelayExecutor.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {Utils} from "../../contracts/Utils.sol";
import {
  ExecuteAndWithdrawRequest,
  Fee
} from "../../contracts/call-resolvers/ICallResolver.sol";
import {PoolDrawResolver} from "../../contracts/call-resolvers/PoolDrawResolver.sol";
import {
  DrawLeg,
  DrawLegKind
} from "../../contracts/call-resolvers/PoolResolverBase.sol";
import {Call} from "../../contracts/call-resolvers/ResolverSandbox.sol";
import {
  DrawAuthorization,
  DrawConfig,
  IFundingPool
} from "../../contracts/funding-pools/IFundingPool.sol";
import {FundingPool} from "../../contracts/funding-pools/FundingPool.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";

/// @notice Curve StableSwap NG surface used by the test
interface ICurveStableSwapNG {
  function get_dy(
    int128 i,
    int128 j,
    uint256 dx
  ) external view returns (uint256);

  function exchange(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 minDy,
    address receiver
  ) external returns (uint256);
}

/// @notice Stand-in builder so the withdrawal leg does not depend on a real
///         destination depository; the fork only exercises the Hub-side
///         settlement
contract CurveForkPayloadBuilder is IPayloadBuilder {
  function buildPayload(
    string calldata,
    bytes calldata,
    WithdrawRequest calldata
  ) external pure returns (bytes memory payload, WithdrawFee memory fee) {
    return (hex"01", WithdrawFee("", 0));
  }

  function hashesToSign(
    string calldata,
    bytes calldata,
    bytes calldata
  ) external pure returns (bytes32[] memory hashes) {
    return new bytes32[](1);
  }

  function curve() external pure returns (string memory name) {
    return "secp256k1";
  }

  function family() external pure returns (string memory name) {
    return "mock";
  }
}

/// @title PoolDrawResolverCurveForkTest
/// @notice Fixed-spread settlement through the deployed dev funding pool,
///         PoolDrawResolver and Curve USDC pool on the Relay devnet (537724).
///         A base USDC order is swapped to ethereum USDC on Curve inside the
///         resolver sandbox; a shortfall leg pins the output to the quoted
///         amount minus the spread, crediting the surplus to the platform
///         account or topping up from it.
/// @dev Skipped unless `DEV_RPC_URL` is set. Pranks the dev security council
///      for test wiring (oracle signer, mock builder); nothing is broadcast.
contract PoolDrawResolverCurveForkTest is BaseTest {
  // Dev deployment set (contracts/relay-chain/deployments/contracts/dev.json)
  RelayHub internal constant HUB =
    RelayHub(0xa884543c91156098B2e50aE17c3840770B7B55f5);
  RelayExecutor internal constant EXECUTOR =
    RelayExecutor(0x8e4740962E0B8fF64A3AE44409572F33f34D97AE);
  RelayAllocator internal constant ALLOCATOR =
    RelayAllocator(0x95bb2652BaA8a1177f750d92384527c5814f5254);
  address internal constant ORACLE = 0x4411881AcDa74849C1811d0b19c8E045c8f4c280;
  address internal constant COUNCIL =
    0x33eB6a492221d23695Bb830Bc5DC905B7Ff9D2d7;
  // Funding pool set redeployed 2026-10-08 (DEC-2276)
  FundingPool internal constant POOL =
    FundingPool(0x9D541AD6da83303Eb603aa1bFb8c540EDF9Acf0b);
  PoolDrawResolver internal constant RESOLVER =
    PoolDrawResolver(0x67D559328650CE362346E822Df5dB6eFA5c65D3E);
  // Curve dev USDC pool (curve-core settings/pools/dev.yaml); coin 0 is
  // ethereum USDC, coin 1 is base USDC
  ICurveStableSwapNG internal constant CURVE =
    ICurveStableSwapNG(0xb0c2C92e5B5057c37bBFBb2f54e0E8fA445B2A1a);
  int128 internal constant CURVE_BASE_INDEX = 1;
  int128 internal constant CURVE_ETHEREUM_INDEX = 0;

  string internal constant IN_CHAIN_ID = "base";
  string internal constant OUT_CHAIN_ID = "ethereum";
  bytes internal constant IN_CURRENCY =
    hex"833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  bytes internal constant OUT_CURRENCY =
    hex"a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  uint256 internal constant ORDER_INPUT = 1_000_000; // 1 base USDC
  uint256 internal constant PLATFORM_FLOAT = 5_000_000; // 5 ethereum USDC
  uint256 internal constant SPREAD_BPS = 10;
  uint256 internal constant UNLIMITED = type(uint256).max;

  bytes32 internal constant EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "ExecuteAndWithdrawRequest(string inChainId,bytes inCurrency,string outChainId,bytes outCurrency,uint256 outAmountMinimum,bytes depository,address orderAddress,bytes receiver,bytes data,Fee[] fees,bytes32 nonce,uint256 deadline)Fee(address recipient,uint256 amount)"
    );

  uint256 internal tokenInId;
  uint256 internal tokenOutId;
  address internal tokenInView;
  address internal tokenOutView;
  bytes32 internal executorDomain;

  address internal oracleSigner;
  uint256 internal oracleSignerPk;
  address internal authorizer;
  uint256 internal authorizerPk;
  address internal platform;
  address internal orderAddress;
  address internal depository;
  address internal receiver;

  bytes internal preparedPayload;

  function setUp() public override {
    string memory rpc = vm.envOr("DEV_RPC_URL", string(""));
    if (bytes(rpc).length == 0) {
      vm.skip(true);
      return;
    }
    vm.createSelectFork(rpc);
    assertEq(block.chainid, 537724, "fork is not the relay devnet");
    super.setUp();

    (oracleSigner, oracleSignerPk) = makeAddrAndKey("fork-oracle-signer");
    (authorizer, authorizerPk) = makeAddrAndKey("fork-authorizer");
    platform = makeAddr("fork-platform");
    orderAddress = makeAddr("fork-order");
    depository = makeAddr("fork-depository");
    receiver = makeAddr("fork-receiver");

    // The draw rename (DEC-2292) changes the pool's selectors, so this test
    // only runs once dev is redeployed from this source and POOL and
    // RESOLVER above point at the new set
    (bool renamed, ) = address(POOL).staticcall(
      abi.encodeCall(IFundingPool.drawNonces, (platform))
    );
    assertTrue(
      renamed,
      "dev funding pool predates the draw rename: redeploy it and update POOL and RESOLVER"
    );

    tokenInId = Utils.generateTokenId(IN_CHAIN_ID, IN_CURRENCY);
    tokenOutId = Utils.generateTokenId(OUT_CHAIN_ID, OUT_CURRENCY);
    tokenInView = HUB.erc20Views(tokenInId);
    tokenOutView = HUB.erc20Views(tokenOutId);
    assertTrue(tokenInView != address(0) && tokenOutView != address(0));

    executorDomain = Eip712.domainSeparator(
      "RelayExecutor",
      "1",
      block.chainid,
      address(EXECUTOR)
    );

    // Test wiring the council owns: an oracle signer for the executor and a
    // mock builder under a throwaway depository so the real ethereum builder
    // is left untouched
    CurveForkPayloadBuilder builder = new CurveForkPayloadBuilder();
    vm.startPrank(COUNCIL);
    EXECUTOR.grantRole(EXECUTOR.ORACLE_ROLE(), oracleSigner);
    ALLOCATOR.setPayloadBuilder(
      OUT_CHAIN_ID,
      abi.encodePacked(depository),
      address(builder)
    );
    vm.stopPrank();

    // Order input and the platform's output float come from the oracle, the
    // way deposits reach the Hub in production
    vm.startPrank(ORACLE);
    HUB.mint(orderAddress, tokenInId, ORDER_INPUT);
    HUB.mint(platform, tokenOutId, PLATFORM_FLOAT);
    vm.stopPrank();

    // Platform account on the deployed pool: float, resolver allowlist, and
    // guardrails naming the test authorizer
    vm.startPrank(platform);
    IERC20(tokenOutView).approve(address(POOL), PLATFORM_FLOAT);
    POOL.depositFor(platform, tokenOutView, PLATFORM_FLOAT);
    POOL.setDrawResolver(address(RESOLVER), true);
    POOL.setDrawConfig(
      tokenOutView,
      DrawConfig({
        perOrderCap: PLATFORM_FLOAT,
        budget: UNLIMITED,
        authorizer: authorizer,
        expiry: 0
      })
    );
    vm.stopPrank();
  }

  /// @notice Target equal to the quote: Curve delivers exactly what get_dy
  ///         said, so the leg neither draws nor credits
  function test_curveQuoteMatchesExecution() public {
    uint256 quote = CURVE.get_dy(
      CURVE_BASE_INDEX,
      CURVE_ETHEREUM_INDEX,
      ORDER_INPUT
    );
    console2.log("quote (ethereum USDC for 1 base USDC):", quote);

    _settle(quote, quote, bytes32(uint256(1)));

    assertEq(
      POOL.balances(platform, tokenOutView),
      PLATFORM_FLOAT,
      "float moved"
    );
    assertFalse(POOL.drawRecords(orderAddress, platform, 0), "unexpected draw");
    _assertNoResidue();
  }

  /// @notice Fixed spread: the target is the quote minus SPREAD_BPS, so the
  ///         user receives the quoted-minus-spread amount and the platform
  ///         account earns the difference as a credit
  function test_fixedSpreadCreditsSurplusToPlatform() public {
    uint256 quote = CURVE.get_dy(
      CURVE_BASE_INDEX,
      CURVE_ETHEREUM_INDEX,
      ORDER_INPUT
    );
    uint256 target = (quote * (10_000 - SPREAD_BPS)) / 10_000;
    console2.log("quote:", quote);
    console2.log("target (quote - 10 bps):", target);
    console2.log("expected spread credit:", quote - target);

    _settle(target, target, bytes32(uint256(2)));

    assertEq(
      POOL.balances(platform, tokenOutView),
      PLATFORM_FLOAT + (quote - target),
      "spread not credited"
    );
    assertFalse(POOL.drawRecords(orderAddress, platform, 0), "unexpected draw");
    _assertNoResidue();
  }

  /// @notice Target above what Curve delivers: the platform tops the output
  ///         up from its float, bounded by its cap, and the draw is recorded
  function test_shortfallTopsUpFromPlatformWhenMarketUnderDelivers() public {
    uint256 quote = CURVE.get_dy(
      CURVE_BASE_INDEX,
      CURVE_ETHEREUM_INDEX,
      ORDER_INPUT
    );
    uint256 target = quote + 20_000; // promise 0.02 USDC more than the market
    console2.log("quote:", quote);
    console2.log("target (quote + 0.02):", target);

    _settle(target, quote, bytes32(uint256(3)));

    assertEq(
      POOL.balances(platform, tokenOutView),
      PLATFORM_FLOAT - 20_000,
      "top-up not drawn"
    );
    assertTrue(
      POOL.drawRecords(orderAddress, platform, 0),
      "draw not recorded"
    );
    _assertNoResidue();
  }

  // Helpers

  /// @notice Runs one order: swap the whole input on Curve inside the
  ///         sandbox, then a shortfall leg to `target` on the platform
  ///         account, with the signed minimum at `target`
  function _settle(uint256 target, uint256 curveMinDy, bytes32 salt) internal {
    Call[] memory calls = new Call[](2);
    calls[0] = Call({
      to: tokenInView,
      data: abi.encodeCall(IERC20.approve, (address(CURVE), ORDER_INPUT))
    });
    calls[1] = Call({
      to: address(CURVE),
      data: abi.encodeCall(
        ICurveStableSwapNG.exchange,
        (
          CURVE_BASE_INDEX,
          CURVE_ETHEREUM_INDEX,
          ORDER_INPUT,
          curveMinDy,
          address(RESOLVER.SANDBOX())
        )
      )
    });

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = DrawLeg({
      pool: address(POOL),
      account: platform,
      kind: DrawLegKind.SHORTFALL_TO_TARGET,
      tokenIn: tokenOutView,
      tokenOut: tokenOutView,
      amount: target,
      amountOutMinimum: 0,
      calls: new Call[](0)
    });

    bytes32 nonce = _prepare(legs, calls, salt);
    ExecuteAndWithdrawRequest memory request = ExecuteAndWithdrawRequest({
      inChainId: IN_CHAIN_ID,
      inCurrency: IN_CURRENCY,
      outChainId: OUT_CHAIN_ID,
      outCurrency: OUT_CURRENCY,
      outAmountMinimum: target,
      depository: abi.encodePacked(depository),
      orderAddress: orderAddress,
      receiver: abi.encodePacked(receiver),
      data: "",
      fees: new Fee[](0),
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });

    uint256 floatBefore = POOL.balances(platform, tokenOutView);
    EXECUTOR.execute(
      request,
      address(RESOLVER),
      preparedPayload,
      oracleSigner,
      _signRequest(request)
    );
    uint256 floatAfter = POOL.balances(platform, tokenOutView);
    if (floatAfter >= floatBefore) {
      console2.log("platform credited:", floatAfter - floatBefore);
    } else {
      console2.log("platform drawn:", floatBefore - floatAfter);
    }
  }

  function _prepare(
    DrawLeg[] memory legs,
    Call[] memory calls,
    bytes32 salt
  ) internal returns (bytes32 nonce) {
    bytes memory executionData = abi.encode(
      PoolDrawResolver.Execution({
        legs: legs,
        calls: calls,
        surplusPool: address(POOL),
        surplusAccount: platform,
        salt: salt
      })
    );
    bytes32 planHash = keccak256(executionData);

    bytes[] memory authorizations = new bytes[](legs.length);
    for (uint256 i; i < legs.length; ++i) {
      DrawAuthorization memory authorization = DrawAuthorization({
        account: legs[i].account,
        orderAddress: orderAddress,
        planHash: planHash,
        nonce: POOL.drawNonces(legs[i].account),
        deadline: block.timestamp + 1 hours
      });
      (uint8 v, bytes32 r, bytes32 s) = vm.sign(
        authorizerPk,
        POOL.hashDrawAuthorization(authorization)
      );
      authorizations[i] = abi.encode(authorization, abi.encodePacked(r, s, v));
    }

    preparedPayload = abi.encode(executionData, authorizations);
    nonce = keccak256(abi.encodePacked(address(RESOLVER), planHash));
  }

  function _signRequest(
    ExecuteAndWithdrawRequest memory request
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH,
        keccak256(bytes(request.inChainId)),
        keccak256(request.inCurrency),
        keccak256(bytes(request.outChainId)),
        keccak256(request.outCurrency),
        request.outAmountMinimum,
        keccak256(request.depository),
        request.orderAddress,
        keccak256(request.receiver),
        keccak256(request.data),
        keccak256(abi.encodePacked(new bytes32[](0))),
        request.nonce,
        request.deadline
      )
    );
    signature = Eip712.sign(oracleSignerPk, executorDomain, structHash);
  }

  function _assertNoResidue() internal view {
    address sandbox = address(RESOLVER.SANDBOX());
    assertEq(HUB.balanceOf(address(EXECUTOR), tokenInId), 0, "executor in");
    assertEq(HUB.balanceOf(address(EXECUTOR), tokenOutId), 0, "executor out");
    assertEq(HUB.balanceOf(address(RESOLVER), tokenInId), 0, "resolver in");
    assertEq(HUB.balanceOf(address(RESOLVER), tokenOutId), 0, "resolver out");
    assertEq(HUB.balanceOf(sandbox, tokenInId), 0, "sandbox in");
    assertEq(HUB.balanceOf(sandbox, tokenOutId), 0, "sandbox out");
  }
}
