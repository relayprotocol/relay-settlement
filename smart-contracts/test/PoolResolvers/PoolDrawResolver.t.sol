// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {
  BuildPayloadParams,
  IPayloadBuilder,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {ERC20View} from "../../contracts/ERC20View.sol";
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
  DrawLegKind,
  PoolResolverBase
} from "../../contracts/call-resolvers/PoolResolverBase.sol";
import {
  Call,
  ResolverSandbox
} from "../../contracts/call-resolvers/ResolverSandbox.sol";
import {
  DrawAuthorization,
  SponsorshipConfig
} from "../../contracts/funding-pools/IRelayFundingPool.sol";
import {RelayFundingPool} from "../../contracts/funding-pools/RelayFundingPool.sol";
import {MyToken} from "../../contracts/test-utils/MyToken.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";

contract DrawResolverPayloadBuilder is IPayloadBuilder {
  function buildPayload(
    string calldata,
    bytes calldata,
    BuildPayloadParams calldata
  ) external pure returns (bytes memory payload) {
    return hex"01";
  }

  function hashesToSign(
    string calldata,
    bytes calldata,
    bytes calldata
  ) external pure returns (bytes32[] memory hashes) {
    return new bytes32[](0);
  }

  function curve() external pure returns (string memory name) {
    return "secp256k1";
  }

  function family() external pure returns (string memory name) {
    return "mock";
  }
}

contract DrawResolverExternalToHubSwapper {
  using SafeERC20 for IERC20;

  RelayHub internal immutable HUB;

  constructor(RelayHub hub) {
    HUB = hub;
  }

  function swap(
    address tokenIn,
    uint256 tokenOutId,
    uint256 amountIn,
    uint256 amountOut
  ) external {
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
    HUB.mint(msg.sender, tokenOutId, amountOut);
  }
}

contract DrawResolverHubSwapper {
  RelayHub internal immutable HUB;

  constructor(RelayHub hub) {
    HUB = hub;
  }

  function swap(
    uint256 tokenInId,
    uint256 tokenOutId,
    uint256 amountIn,
    uint256 amountOut
  ) external {
    require(HUB.transferFrom(msg.sender, address(this), tokenInId, amountIn));
    HUB.mint(msg.sender, tokenOutId, amountOut);
  }
}

contract PoolDrawResolverTest is BaseTest {
  string internal constant IN_CHAIN_ID = "ethereum-mainnet";
  string internal constant OUT_CHAIN_ID = "base-mainnet";
  bytes32 internal constant EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "ExecuteAndWithdrawRequest(string inChainId,bytes inCurrency,string outChainId,bytes outCurrency,uint256 outAmountMinimum,bytes depository,address orderAddress,bytes receiver,bytes data,Fee[] fees,bytes32 nonce,uint256 deadline)Fee(address recipient,uint256 amount)"
    );

  bytes32 internal constant FEE_TYPEHASH =
    keccak256("Fee(address recipient,uint256 amount)");

  uint256 internal constant UNLIMITED = type(uint256).max;

  RelayHub internal hub;
  RelayAllocator internal allocator;
  RelayExecutor internal executor;
  RelayFundingPool internal pool;
  PoolDrawResolver internal drawResolver;
  MyToken internal externalToken;
  DrawResolverExternalToHubSwapper internal externalSwapper;
  DrawResolverHubSwapper internal hubSwapper;

  /// @notice Payload of the settlement being tested, encoded by `_prepare`.
  ///         The oracle-signed nonce commits to it, so it is composed before
  ///         the request — exactly as the production flow requires
  bytes internal preparedPayload;
  bytes internal preparedExecutionData;
  // Per-leg override consumed by the next `_prepare` call. Tests that need a
  // rejected authorization push theirs here instead of receiving the valid one
  bytes[] internal authorizationOverrides;

  address internal oracleSigner;
  uint256 internal oracleSignerPk;
  /// @notice Operator key every configured account names as its authorizer —
  ///         the canonical setup, where accounts stay offline and the platform
  ///         authorizes the orders it composed plans for
  address internal authorizer;
  uint256 internal authorizerPk;
  address internal platform;
  address internal app;
  address internal bystanderSponsor;
  address internal depository;
  address internal receiver;
  address internal feeRecipient;
  bytes internal inCurrency;
  bytes internal outCurrency;
  uint256 internal tokenInId;
  uint256 internal tokenOutId;
  address internal tokenInView;
  address internal tokenOutView;
  bytes32 internal executorDomain;

  function setUp() public override {
    super.setUp();
    (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");
    (authorizer, authorizerPk) = makeAddrAndKey("authorizer");
    platform = makeAddr("platform");
    app = makeAddr("app");
    bystanderSponsor = makeAddr("bystanderSponsor");
    depository = otherAccounts[0];
    receiver = otherAccounts[1];
    feeRecipient = otherAccounts[2];
    inCurrency = abi.encodePacked(address(1));
    outCurrency = abi.encodePacked(address(2));

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0xbeef));
    executor = new RelayExecutor(owner, address(hub), address(allocator));
    // Legs name their pool per draw, so the resolver binds no pool at
    // deployment; it is granted RESOLVER_ROLE on the pool below
    pool = new RelayFundingPool(owner, owner, owner);
    drawResolver = new PoolDrawResolver(address(executor), address(hub));
    externalToken = new MyToken();
    externalSwapper = new DrawResolverExternalToHubSwapper(hub);
    hubSwapper = new DrawResolverHubSwapper(hub);

    DrawResolverPayloadBuilder payloadBuilder = new DrawResolverPayloadBuilder();
    vm.prank(owner);
    allocator.setPayloadBuilder(
      OUT_CHAIN_ID,
      abi.encodePacked(depository),
      address(payloadBuilder)
    );

    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(executor));
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    hub.grantRole(hub.OPERATOR_ROLE(), address(externalSwapper));
    hub.grantRole(hub.OPERATOR_ROLE(), address(hubSwapper));
    executor.grantRole(executor.ORACLE_ROLE(), oracleSigner);
    pool.grantRole(pool.RESOLVER_ROLE(), address(drawResolver));
    vm.stopPrank();

    tokenInId = Utils.generateTokenId(IN_CHAIN_ID, inCurrency);
    tokenOutId = Utils.generateTokenId(OUT_CHAIN_ID, outCurrency);

    // Create both ERC-20 views before funding accounts
    vm.startPrank(owner);
    hub.mint(owner, tokenInId, 1);
    hub.burn(owner, tokenInId, 1);
    hub.mint(owner, tokenOutId, 1);
    hub.burn(owner, tokenOutId, 1);
    vm.stopPrank();
    tokenInView = hub.erc20Views(tokenInId);
    tokenOutView = hub.erc20Views(tokenOutId);

    executorDomain = Eip712.domainSeparator(
      "RelayExecutor",
      "1",
      block.chainid,
      address(executor)
    );

    // Platform account: output-currency float for shortfall legs
    _depositHubToken(platform, tokenOutId, tokenOutView, 1_000);
    _configureAccount(platform, tokenOutView, 50);

    // App account: input-currency balance for fixed fee-sponsorship legs and
    // an external-token balance for conversion legs
    _depositHubToken(app, tokenInId, tokenInView, 100);
    _configureAccount(app, tokenInView, 20);
    externalToken.mintFor(100, owner);
    vm.startPrank(owner);
    externalToken.approve(address(pool), 100);
    pool.depositFor(app, address(externalToken), 100);
    vm.stopPrank();
    vm.prank(app);
    pool.setSponsorshipConfig(
      address(externalToken),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: UNLIMITED,
        authorizer: authorizer,
        expiry: 0
      })
    );

    // A sponsor sharing the pool whose balance no draw leg touches. Its
    // config allowlists the resolver, so only payload targeting protects it
    _depositHubToken(bystanderSponsor, tokenOutId, tokenOutView, 200);
    _configureAccount(bystanderSponsor, tokenOutView, 50);
  }

  // Shortfall settlement branches

  function test_overDeliveryCreditsSurplusToPlatformAccount() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    // The market over-delivers: 120 produced against a 110 target
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 120);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 110);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(1)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectEmit(address(drawResolver));
    emit PoolResolverBase.DrawLegExecuted(
      orderAddress,
      address(pool),
      platform,
      requestHash,
      DrawLegKind.SHORTFALL_TO_TARGET,
      tokenOutView,
      tokenOutView,
      0,
      10
    );
    _execute(request);

    // The 10 surplus went back to the account that funds shortfalls
    assertEq(pool.balances(platform, tokenOutView), 1_010);
    assertFalse(pool.drawRecords(orderAddress, platform, 0));
    assertEq(hub.balanceOf(address(pool), tokenOutId), 1_210);
  }

  function test_underDeliveryTopsUpFromPlatformAccount() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    // The market under-delivers: 90 produced against a 100 target
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(2)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectEmit(address(drawResolver));
    emit PoolResolverBase.DrawLegExecuted(
      orderAddress,
      address(pool),
      platform,
      requestHash,
      DrawLegKind.SHORTFALL_TO_TARGET,
      tokenOutView,
      tokenOutView,
      10,
      0
    );
    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 990);
    assertTrue(pool.drawRecords(orderAddress, platform, 0));
    // Coexistence: the bystander sponsor's balance in the shared pool is
    // untouched by the platform's draw
    assertEq(pool.balances(bystanderSponsor, tokenOutView), 200);
  }

  function test_exactTargetNeitherDrawsNorCredits() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(3)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertFalse(pool.drawRecords(orderAddress, platform, 0));
  }

  function test_shortfallBeyondCapUnwindsAtomically() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    // A big depeg: the 60 shortfall exceeds the platform's 50 per-order cap
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 40);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(4)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        platform,
        tokenOutView,
        60,
        50
      )
    );
    _execute(request);

    // Nothing settled: the order input is untouched, the platform balance is
    // intact and the draw record stays unset, so the origin refund path and a
    // retry both remain open
    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);
    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertFalse(pool.drawRecords(orderAddress, platform, 0));
  }

  function test_shortfallBeyondAccountBalanceUnwindsAtomically() public {
    // An account whose config allows more than its balance covers
    address poorPlatform = makeAddr("poorPlatform");
    _depositHubToken(poorPlatform, tokenOutId, tokenOutView, 5);
    _configureAccount(poorPlatform, tokenOutView, 50);

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(poorPlatform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(5)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InsufficientBalance.selector,
        poorPlatform,
        tokenOutView,
        10,
        5
      )
    );
    _execute(request);

    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);
    assertEq(pool.balances(poorPlatform, tokenOutView), 5);
    assertFalse(pool.drawRecords(orderAddress, poorPlatform, 0));
  }

  // Composed orders

  function test_composedOrderSettlesAppFeeAndPlatformPeg() public {
    // The app sponsors its 10-unit fee with a fixed leg while the platform
    // account guarantees the output peg with a shortfall leg — one atomic
    // execution against two accounts in the shared pool
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 110);

    // The fee draw restores the full 110 notional; the market under-delivers
    // 105, so the platform tops up 5
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 105);

    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(app, tokenInView, 10);
    legs[1] = _shortfallLeg(platform, tokenOutView, 110);

    ExecuteAndWithdrawRequest memory request = _requestWithFee(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(6))),
      10
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    assertEq(pool.balances(app, tokenInView), 90);
    assertEq(pool.balances(platform, tokenOutView), 995);
    assertTrue(pool.drawRecords(orderAddress, app, 0));
    assertTrue(pool.drawRecords(orderAddress, platform, 1));
    assertEq(hub.balanceOf(feeRecipient, tokenInId), 10);
    assertEq(pool.balances(bystanderSponsor, tokenOutView), 200);
  }

  function test_composedOrderShortfallFailureUnwindsFixedLeg() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 110);

    // The shortfall (70) blows through the platform cap, so the whole
    // settlement reverts — including the app's already-executed fixed leg
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 40);

    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(app, tokenInView, 10);
    legs[1] = _shortfallLeg(platform, tokenOutView, 110);

    ExecuteAndWithdrawRequest memory request = _requestWithFee(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(7))),
      10
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        platform,
        tokenOutView,
        70,
        50
      )
    );
    _execute(request);

    assertEq(hub.balanceOf(orderAddress, tokenInId), 110);
    assertEq(pool.balances(app, tokenInView), 100);
    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertFalse(pool.drawRecords(orderAddress, app, 0));
    assertFalse(pool.drawRecords(orderAddress, platform, 1));
    assertEq(hub.balanceOf(feeRecipient, tokenInId), 0);
  }

  function test_fixedLegConvertsExternalFloatAndRefundsUnspentInput() public {
    // The app's float is an external token: the fixed leg draws 20, converts
    // 15 into 10 units of the order input, and the unspent 5 is credited back
    // to the app's account rather than stranded or leaked
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory legCalls = new Call[](2);
    legCalls[0] = Call({
      to: address(externalToken),
      data: abi.encodeCall(IERC20.approve, (address(externalSwapper), 15))
    });
    legCalls[1] = Call({
      to: address(externalSwapper),
      data: abi.encodeCall(
        DrawResolverExternalToHubSwapper.swap,
        (address(externalToken), tokenInId, 15, 10)
      )
    });

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = DrawLeg({
      pool: address(pool),
      account: app,
      kind: DrawLegKind.FIXED,
      tokenIn: address(externalToken),
      tokenOut: tokenInView,
      amount: 20,
      amountOutMinimum: 10,
      calls: legCalls
    });

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 110);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(8)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    // 20 drawn, 15 spent, 5 credited back
    assertEq(pool.balances(app, address(externalToken)), 85);
    assertEq(externalToken.balanceOf(address(externalSwapper)), 15);
    assertTrue(pool.drawRecords(orderAddress, app, 0));
    assertEq(externalToken.balanceOf(address(drawResolver)), 0);
  }

  function test_fixedLegConversionBelowMinimumReverts() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory legCalls = new Call[](2);
    legCalls[0] = Call({
      to: address(externalToken),
      data: abi.encodeCall(IERC20.approve, (address(externalSwapper), 20))
    });
    legCalls[1] = Call({
      to: address(externalSwapper),
      data: abi.encodeCall(
        DrawResolverExternalToHubSwapper.swap,
        (address(externalToken), tokenInId, 20, 9)
      )
    });

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = DrawLeg({
      pool: address(pool),
      account: app,
      kind: DrawLegKind.FIXED,
      tokenIn: address(externalToken),
      tokenOut: tokenInView,
      amount: 20,
      amountOutMinimum: 10,
      calls: legCalls
    });

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 110);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(9)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        PoolResolverBase.InsufficientDrawLegOutput.selector,
        tokenInView,
        9,
        10
      )
    );
    _execute(request);

    assertEq(pool.balances(app, address(externalToken)), 100);
  }

  // Payload validation

  function test_misorderedLegsRevert() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    // A fixed leg after a shortfall leg is rejected: it would draw after the
    // output was already measured and trimmed
    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);
    legs[1] = _fixedLeg(app, tokenInView, 10);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(10)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(PoolDrawResolver.MisorderedDrawLegs.selector, 1)
    );
    _execute(request);
  }

  function test_sameAccountLegsSettleWithinPerOrderCap() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 115, 110);

    // Two legs may draw the same account in one order — each records its own
    // leg index and the per-order cap bounds their sum (15 of the app's 20)
    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(app, tokenInView, 10);
    legs[1] = _fixedLeg(app, tokenInView, 5);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(11)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    assertEq(pool.balances(app, tokenInView), 85);
    assertTrue(pool.drawRecords(orderAddress, app, 0));
    assertTrue(pool.drawRecords(orderAddress, app, 1));
    assertEq(pool.orderDraws(orderAddress, app, tokenInView), 15);
  }

  // Adversarial: third-party payloads and repeat attestations (DEC-1696)

  function test_thirdPartyPayloadCannotDrawAConsentingAccount() public {
    // The reported drain: `execute` is permissionless and the resolver payload
    // is unsigned calldata, so anyone can compose a plan naming any account
    // that allowlisted this resolver. The payload commitment only proves the
    // plan was not swapped after attestation — it is computed by whoever wrote
    // the plan, so it cannot vouch for the plan's author. What refuses the draw
    // is the account's authorizer never having authorized this order.
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    // The attacker names the bystander sponsor and self-signs the
    // authorization with a key of their own
    (, uint256 attackerPk) = makeAddrAndKey("attacker");
    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _fixedLeg(bystanderSponsor, tokenOutView, 50);
    authorizationOverrides.push(
      _authorize(attackerPk, pool, bystanderSponsor, orderAddress)
    );

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(30)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        bystanderSponsor,
        authorizer,
        orderAddress
      )
    );
    _execute(request);

    assertEq(pool.balances(bystanderSponsor, tokenOutView), 200);
    assertFalse(pool.drawRecords(orderAddress, bystanderSponsor, 0));
  }

  function test_capDoesNotRearmOnASecondAttestationOfTheSameOrder() public {
    // Step 4 of the reported drain: mint a fresh attestation for the same order
    // and the per-order cap re-arms. It cannot now — the records key on the
    // order address, which is inside the signed request and identical across
    // both attestations, while the digests differ because the salt does
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    DrawLeg[] memory firstLegs = new DrawLeg[](1);
    firstLegs[0] = _fixedLeg(app, tokenInView, 20);
    ExecuteAndWithdrawRequest memory firstRequest = _request(
      orderAddress,
      100,
      _prepare(orderAddress, firstLegs, calls, bytes32(uint256(31)))
    );
    _execute(firstRequest);

    // The app's whole 20 cap is spent for this order
    assertEq(pool.balances(app, tokenInView), 80);
    assertEq(pool.orderDraws(orderAddress, app, tokenInView), 20);

    // Second attestation of the same order: different salt, so a different
    // payload, nonce and digest — but the same order address
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    DrawLeg[] memory secondLegs = new DrawLeg[](1);
    secondLegs[0] = _fixedLeg(app, tokenInView, 20);
    ExecuteAndWithdrawRequest memory secondRequest = _request(
      orderAddress,
      100,
      _prepare(orderAddress, secondLegs, calls, bytes32(uint256(32)))
    );
    assertTrue(
      executor.hashExecuteAndWithdrawRequest(firstRequest) !=
        executor.hashExecuteAndWithdrawRequest(secondRequest)
    );

    // Same leg index, so the draw record is the guard that fires; a fresh leg
    // index under a second attestation runs into the cap instead, which
    // `test_perOrderCapDoesNotRearmAcrossAttestationsOfOneOrder` pins at the
    // pool level. Either way the order cannot be drawn twice
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.AlreadyDrawn.selector,
        orderAddress,
        app,
        0
      )
    );
    _execute(secondRequest);

    assertEq(pool.balances(app, tokenInView), 80);
    assertEq(pool.orderDraws(orderAddress, app, tokenInView), 20);
  }

  function test_sameAccountLegsBeyondPerOrderCapUnwindAtomically() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    // Each leg fits the app's 20 cap alone, but their 25 sum does not: the
    // cap bounds the account's total per order, so splitting a draw across
    // legs cannot stretch it
    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(app, tokenInView, 10);
    legs[1] = _fixedLeg(app, tokenInView, 15);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(19)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        app,
        tokenInView,
        25,
        20
      )
    );
    _execute(request);

    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);
    assertEq(pool.balances(app, tokenInView), 100);
    assertFalse(pool.drawRecords(orderAddress, app, 0));
    assertFalse(pool.drawRecords(orderAddress, app, 1));
  }

  function test_sameAccountFixedAndShortfallLegsShareTheCap() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    // The platform sponsors 10 output units up front and guarantees a 115
    // target: the fixed draw joins the produced output, so the shortfall leg
    // only tops up the missing 5 — 15 total against the platform's 50 cap
    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(platform, tokenOutView, 10);
    legs[1] = _shortfallLeg(platform, tokenOutView, 115);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      115,
      _prepare(orderAddress, legs, calls, bytes32(uint256(20)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 985);
    assertTrue(pool.drawRecords(orderAddress, platform, 0));
    assertTrue(pool.drawRecords(orderAddress, platform, 1));
    assertEq(pool.orderDraws(orderAddress, platform, tokenOutView), 15);
  }

  function test_shortfallLegRejectsTokenMismatch() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = DrawLeg({
      pool: address(pool),
      account: platform,
      kind: DrawLegKind.SHORTFALL_TO_TARGET,
      tokenIn: tokenInView,
      tokenOut: tokenOutView,
      amount: 100,
      amountOutMinimum: 0,
      calls: new Call[](0)
    });

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(12)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        PoolResolverBase.ShortfallTokenMismatch.selector,
        tokenInView,
        tokenOutView
      )
    );
    _execute(request);
  }

  function test_legAgainstNonConsentingAccountReverts() public {
    // An account that never allowlisted this resolver cannot be drawn, even
    // though it holds a balance in the shared pool
    address unrelated = makeAddr("unrelatedAccount");
    _depositHubToken(unrelated, tokenOutId, tokenOutView, 100);

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(unrelated, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(13)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.ResolverNotAllowed.selector,
        unrelated,
        address(drawResolver)
      )
    );
    _execute(request);

    assertEq(pool.balances(unrelated, tokenOutView), 100);
  }

  /// @notice DEC-1465 regression for the draw resolver: a `pool.debit`
  ///         smuggled into the solver-supplied calls must not drain the pool.
  ///         The calls run in the unprivileged {ResolverSandbox}, which holds
  ///         no RESOLVER_ROLE, so the nested debit reverts and unwinds the
  ///         whole settlement.
  function test_nestedPoolDebitInSolverCallsCannotDrainPool() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    // The smuggled debit names an arbitrary request hash — the payload must
    // be final before the request exists, and the sandbox's missing role
    // makes it fail regardless of the hash it claims
    Call[] memory calls = new Call[](2);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);
    calls[1] = Call({
      to: address(pool),
      data: abi.encodeWithSignature(
        "debit(address,address,uint256,bytes32,uint256,uint8)",
        platform,
        tokenOutView,
        50,
        keccak256("smuggled-request-hash"),
        uint256(0),
        uint8(DrawLegKind.FIXED)
      )
    });

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs0(), calls, bytes32(uint256(14)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    vm.expectPartialRevert(ResolverSandbox.CallFailed.selector);
    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertFalse(pool.drawRecords(orderAddress, platform, 0));
  }

  function test_zeroLegsBehavesLikeBasicResolution() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs0(), calls, bytes32(uint256(15)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertFalse(pool.drawRecords(orderAddress, platform, 0));
  }

  function test_zeroPoolLegReverts() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);
    legs[0].pool = address(0);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(16)))
    );

    vm.expectRevert(PoolResolverBase.ZeroAddress.selector);
    _execute(request);
  }

  function test_legAgainstPoolWithoutResolverRoleReverts() public {
    // A leg naming a pool that never granted this resolver RESOLVER_ROLE
    // reverts the settlement, even when the account there consents
    RelayFundingPool foreignPool = new RelayFundingPool(owner, owner, owner);
    _depositHubTokenIn(foreignPool, platform, tokenOutId, tokenOutView, 100);
    _configureAccountIn(foreignPool, platform, tokenOutView, 50);

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLegIn(foreignPool, platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(17)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        address(drawResolver),
        foreignPool.RESOLVER_ROLE()
      )
    );
    _execute(request);

    assertEq(foreignPool.balances(platform, tokenOutView), 100);
  }

  function test_composedLegsAcrossTwoPoolsSettle() public {
    // The app sponsors its fee from the first pool while the platform
    // guarantees the peg from a second pool — one atomic execution across
    // two pools, each leg gated by its own pool's config
    RelayFundingPool secondPool = new RelayFundingPool(owner, owner, owner);
    bytes32 resolverRole = secondPool.RESOLVER_ROLE();
    vm.prank(owner);
    secondPool.grantRole(resolverRole, address(drawResolver));
    _depositHubTokenIn(secondPool, platform, tokenOutId, tokenOutView, 1_000);
    _configureAccountIn(secondPool, platform, tokenOutView, 50);

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 110);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 105);

    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = _fixedLeg(app, tokenInView, 10);
    legs[1] = _shortfallLegIn(secondPool, platform, tokenOutView, 110);

    ExecuteAndWithdrawRequest memory request = _requestWithFee(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(18))),
      10
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    _execute(request);

    // The fee draw settled in the first pool, the peg top-up in the second;
    // the platform's balance in the first pool is untouched
    assertEq(pool.balances(app, tokenInView), 90);
    assertEq(pool.balances(platform, tokenOutView), 1_000);
    assertEq(secondPool.balances(platform, tokenOutView), 995);
    assertTrue(pool.drawRecords(orderAddress, app, 0));
    assertFalse(pool.drawRecords(orderAddress, platform, 1));
    assertTrue(secondPool.drawRecords(orderAddress, platform, 1));
  }

  // Adversarial: drain resistance (DEC-1675)

  function test_authorizationFromAnotherPoolDomainReverts() public {
    // Each pool is its own EIP-712 verifying contract, so an authorization is
    // only valid for the pool whose domain minted it. Without that binding, an
    // account consenting to one pool would be drawable in every pool it is
    // credited in, on the strength of a single signature
    RelayFundingPool secondPool = new RelayFundingPool(owner, owner, owner);
    bytes32 resolverRole = secondPool.RESOLVER_ROLE();
    vm.prank(owner);
    secondPool.grantRole(resolverRole, address(drawResolver));
    _depositHubTokenIn(secondPool, platform, tokenOutId, tokenOutView, 1_000);
    _configureAccountIn(secondPool, platform, tokenOutView, 50);

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    // The leg draws the second pool, but the authorization is minted in the
    // first pool's domain -- the right authorizer, the right account, the right
    // order, and still refused
    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _fixedLegIn(secondPool, platform, tokenOutView, 50);
    authorizationOverrides.push(
      _authorize(authorizerPk, pool, platform, orderAddress)
    );

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(43)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        platform,
        authorizer,
        orderAddress
      )
    );
    _execute(request);

    assertEq(secondPool.balances(platform, tokenOutView), 1_000);
    assertFalse(secondPool.drawRecords(orderAddress, platform, 0));
  }

  function test_shortfallTargetBelowMinimumCannotSkimOutputIntoCredit() public {
    // A malicious payload sets the shortfall target below the user's signed
    // minimum, trying to skim produced output into a pool credit. The
    // executor's final outAmountMinimum check is the backstop: the swept
    // output falls short, the whole settlement reverts, and the skimmed credit
    // is unwound
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    // Market delivers exactly the 100 minimum, but the leg targets only 90
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 90);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(19)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InsufficientMinimumAmount.selector,
        tokenOutId,
        90,
        100
      )
    );
    _execute(request);

    // The 10 the payload tried to skim into the platform account is unwound
    assertEq(pool.balances(platform, tokenOutView), 1_000);
  }

  function test_substitutedLegsFailPayloadCommitment() public {
    // A front-runner replays the oracle signature with rewritten legs — here
    // inflating the app's sponsored draw from 10 to 15, still within the
    // app's 20 cap, hoping to pocket the difference. The signed nonce commits
    // to the attested payload, so the substituted bytes are refused before
    // any draw
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 110, 110);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _fixedLeg(app, tokenInView, 10);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      110,
      _prepare(orderAddress, legs, calls, bytes32(uint256(23)))
    );
    bytes32 requestHash = executor.hashExecuteAndWithdrawRequest(request);

    DrawLeg[] memory substituted = new DrawLeg[](1);
    substituted[0] = _fixedLeg(app, tokenInView, 15);
    bytes memory substitutedExecution = abi.encode(
      PoolDrawResolver.Execution({
        legs: substituted,
        calls: calls,
        salt: bytes32(uint256(23))
      })
    );
    // The front-runner copies the valid authorization from the mempool — it is
    // not what stops them, the commitment over the plan is
    bytes[] memory copiedAuthorizations = new bytes[](1);
    copiedAuthorizations[0] = _authorize(authorizerPk, pool, app, orderAddress);
    bytes memory substitutedPayload = abi.encode(
      substitutedExecution,
      copiedAuthorizations
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        PoolResolverBase.PayloadCommitmentMismatch.selector,
        request.nonce,
        _commitmentNonce(address(drawResolver), substitutedExecution)
      )
    );
    executor.execute(
      request,
      address(drawResolver),
      substitutedPayload,
      oracleSigner,
      _signRequest(request)
    );

    // Refused up front: no draw settled and the order stays intact
    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);
    assertEq(pool.balances(app, tokenInView), 100);
    assertFalse(pool.drawRecords(orderAddress, app, 0));
  }

  function test_redirectedPayloadFailsCommitmentOnOtherResolver() public {
    // A front-runner redirects the attested payload to another resolver
    // instance — even one holding RESOLVER_ROLE. The commitment binds the
    // payload to one resolver address, so the redirected call fails its
    // commitment check before reaching any pool
    PoolDrawResolver otherResolver = new PoolDrawResolver(
      address(executor),
      address(hub)
    );
    vm.startPrank(owner);
    pool.grantRole(pool.RESOLVER_ROLE(), address(otherResolver));
    vm.stopPrank();

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(24)))
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        PoolResolverBase.PayloadCommitmentMismatch.selector,
        request.nonce,
        _commitmentNonce(address(otherResolver), preparedExecutionData)
      )
    );
    executor.execute(
      request,
      address(otherResolver),
      preparedPayload,
      oracleSigner,
      _signRequest(request)
    );

    assertEq(pool.balances(platform, tokenOutView), 1_000);
  }

  function test_substitutedResolverWithoutRoleCannotDrawPool() public {
    // Even a request whose nonce commits to an attacker-deployed resolver —
    // the oracle would have to attest to it — cannot draw the pool: the
    // resolver holds no RESOLVER_ROLE there, so its debit reverts and no
    // account balance moves
    PoolDrawResolver rogueResolver = new PoolDrawResolver(
      address(executor),
      address(hub)
    );

    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    bytes memory rogueExecution = abi.encode(
      PoolDrawResolver.Execution({
        legs: legs,
        calls: calls,
        salt: bytes32(uint256(20))
      })
    );
    bytes memory roguePayload = abi.encode(rogueExecution, new bytes[](1));

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _commitmentNonce(address(rogueResolver), rogueExecution)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        address(rogueResolver),
        pool.RESOLVER_ROLE()
      )
    );
    executor.execute(
      request,
      address(rogueResolver),
      roguePayload,
      oracleSigner,
      _signRequest(request)
    );

    assertEq(pool.balances(platform, tokenOutView), 1_000);
  }

  function test_consumedOracleDigestCannotBeReusedWithSubstitutedLegs() public {
    // The oracle authorization is single-use by digest: once a settlement
    // consumes it, the same signature cannot be replayed at all — the
    // executor refuses it before the resolver could even check the payload
    // commitment
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs0(), calls, bytes32(uint256(21)))
    );
    bytes32 digest = executor.hashExecuteAndWithdrawRequest(request);

    // First execution consumes the digest with no legs
    _execute(request);

    // A replay carrying a substituted shortfall leg is refused up front
    DrawLeg[] memory substituted = new DrawLeg[](1);
    substituted[0] = _shortfallLeg(platform, tokenOutView, 100);
    bytes memory substitutedPayload = abi.encode(
      abi.encode(
        PoolDrawResolver.Execution({
          legs: substituted,
          calls: calls,
          salt: bytes32(uint256(21))
        })
      ),
      new bytes[](1)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        digest
      )
    );
    executor.execute(
      request,
      address(drawResolver),
      substitutedPayload,
      oracleSigner,
      _signRequest(request)
    );
  }

  function test_identicalPayloadRetryAfterTransientRevertSucceeds() public {
    // A settlement that reverts for a transient reason (pool paused) does not
    // burn the oracle authorization: the identical payload settles on retry
    // once the condition clears, with no re-attestation
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(22)))
    );

    vm.prank(owner);
    pool.pause();

    vm.expectRevert(Pausable.EnforcedPause.selector);
    _execute(request);

    // The order funds and the authorization both survived the reverted attempt
    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);

    vm.prank(owner);
    pool.unpause();

    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 990);
    assertTrue(pool.drawRecords(orderAddress, platform, 0));
  }

  function test_saltAloneChangesTheCommitmentNonce() public view {
    // Identical plans across two orders must carry distinct salts: the salt
    // alone changes the commitment nonce, which the allocator requires to be
    // unique per order
    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 100);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    bytes32 first = _commitmentNonce(
      address(drawResolver),
      abi.encode(
        PoolDrawResolver.Execution({
          legs: legs,
          calls: calls,
          salt: bytes32(uint256(1))
        })
      )
    );
    bytes32 second = _commitmentNonce(
      address(drawResolver),
      abi.encode(
        PoolDrawResolver.Execution({
          legs: legs,
          calls: calls,
          salt: bytes32(uint256(2))
        })
      )
    );

    assertNotEq(first, second);
  }

  function test_tamperedAuthorizationFailsClosedAtThePool() public {
    // The authorizations ride outside the committed bytes, so a front-runner
    // can rewrite them without tripping the commitment. What they cannot do is
    // forge one: the pool verifies the signature against the account's
    // configured authorizer, so the tampered settlement reverts with no draw
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(40)))
    );

    // Same committed plan, garbage authorization: the commitment passes and
    // the pool is what refuses
    bytes[] memory tampered = new bytes[](1);
    tampered[0] = hex"deadbeef";
    bytes memory tamperedPayload = abi.encode(preparedExecutionData, tampered);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        platform,
        authorizer,
        orderAddress
      )
    );
    executor.execute(
      request,
      address(drawResolver),
      tamperedPayload,
      oracleSigner,
      _signRequest(request)
    );

    // Fail closed: the untampered settlement still lands afterwards
    assertEq(pool.balances(platform, tokenOutView), 1_000);
    _execute(request);
    assertEq(pool.balances(platform, tokenOutView), 990);
  }

  function test_authorizationCountMismatchReverts() public {
    // The committed plan names one leg; the uncommitted half carries no
    // authorization for it. Refused before any leg runs
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _prepare(orderAddress, legs, calls, bytes32(uint256(41)))
    );

    bytes memory strippedPayload = abi.encode(
      preparedExecutionData,
      new bytes[](0)
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        PoolDrawResolver.AuthorizationCountMismatch.selector,
        1,
        0
      )
    );
    executor.execute(
      request,
      address(drawResolver),
      strippedPayload,
      oracleSigner,
      _signRequest(request)
    );

    assertEq(pool.balances(platform, tokenOutView), 1_000);
  }

  function test_authorizationSignedAfterAttestationSettles() public {
    // The ordering the split payload exists to allow: the plan is committed
    // and the request nonce derived first — attestation time — and the draw
    // authorization is signed afterwards, once the order address is known.
    // Nothing about the attested nonce changes when the signature is attached
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Call[] memory calls = new Call[](1);
    calls[0] = _hubSwap(tokenInId, tokenOutId, 100, 90);

    DrawLeg[] memory legs = new DrawLeg[](1);
    legs[0] = _shortfallLeg(platform, tokenOutView, 100);

    // 1. Commit the plan and derive the nonce, with no authorization in sight
    bytes memory executionData = abi.encode(
      PoolDrawResolver.Execution({
        legs: legs,
        calls: calls,
        salt: bytes32(uint256(42))
      })
    );
    ExecuteAndWithdrawRequest memory request = _request(
      orderAddress,
      100,
      _commitmentNonce(address(drawResolver), executionData)
    );

    // 2. Only now sign the authorization and attach it outside the commitment
    bytes[] memory authorizations = new bytes[](1);
    authorizations[0] = _authorize(authorizerPk, pool, platform, orderAddress);
    preparedPayload = abi.encode(executionData, authorizations);

    _execute(request);

    assertEq(pool.balances(platform, tokenOutView), 990);
    assertTrue(pool.drawRecords(orderAddress, platform, 0));
  }

  /// @notice Cross-language fixture shared with
  ///         packages/sdk/test/funding-pool.test.ts — guards the TS
  ///         `encodePoolDrawResolverExecution` against drifting from the
  ///         Solidity `Execution` ABI shape
  function test_executionEncodingMatchesSdkFixture() public pure {
    Call[] memory legCalls = new Call[](1);
    legCalls[0] = Call({
      to: 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB,
      data: hex"01020304"
    });

    DrawLeg[] memory legs = new DrawLeg[](2);
    legs[0] = DrawLeg({
      pool: 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f,
      account: 0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd,
      kind: DrawLegKind.FIXED,
      tokenIn: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE,
      tokenOut: 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF,
      amount: 4_000_000,
      amountOutMinimum: 3_900_000,
      calls: legCalls
    });
    legs[1] = DrawLeg({
      pool: 0x5656565656565656565656565656565656565656,
      account: 0x1212121212121212121212121212121212121212,
      kind: DrawLegKind.SHORTFALL_TO_TARGET,
      tokenIn: 0x3434343434343434343434343434343434343434,
      tokenOut: 0x3434343434343434343434343434343434343434,
      amount: 10_000_000_000,
      amountOutMinimum: 0,
      calls: new Call[](0)
    });

    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC,
      data: hex"05060708"
    });

    bytes memory executionData = abi.encode(
      PoolDrawResolver.Execution({
        legs: legs,
        calls: calls,
        salt: bytes32(uint256(42))
      })
    );
    assertEq(
      keccak256(executionData),
      0x79bea5134464aa47b9d4993ae0f08bd33f0a9469f675a0a3de105aabc05f8ac5
    );
  }

  /// @notice Cross-language fixture shared with
  ///         packages/sdk/test/funding-pool.test.ts — guards the TS
  ///         `getPoolDrawResolverCommitmentNonce` against drifting from the Solidity
  ///         derivation in `PoolResolverBase._requirePayloadCommitment`
  function test_commitmentNonceMatchesSdkFixture() public pure {
    bytes32 nonce = keccak256(
      abi.encodePacked(
        address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f),
        keccak256(hex"deadbeef")
      )
    );
    assertEq(
      nonce,
      0xe4890326743cc98f49d9488f5eb62e5525cdcc97748aadbd8b2a14baaa9d458b
    );
  }

  // Helpers

  function legs0() internal pure returns (DrawLeg[] memory legs) {
    legs = new DrawLeg[](0);
  }

  /// @notice Encodes and stores the settlement payload, returning the nonce
  ///         the oracle must sign for it — `keccak256(resolver ‖
  ///         keccak256(executionData))`. Mirrors the production flow: the
  ///         committed plan is final before the request is attested, while the
  ///         draw authorizations ride beside it uncommitted
  /// @dev Signs the per-order draw authorization for every leg, mirroring the
  ///      platform authorizing the order it composed the plan for. Tests that
  ///      need a rejected authorization push it onto `authorizationOverrides`
  ///      before calling; the overrides are consumed by index and cleared.
  function _prepare(
    address orderAddress,
    DrawLeg[] memory legs,
    Call[] memory calls,
    bytes32 salt
  ) internal returns (bytes32 nonce) {
    uint256 length = legs.length;
    bytes[] memory authorizations = new bytes[](length);
    for (uint256 i; i < length; ++i) {
      if (i < authorizationOverrides.length) {
        authorizations[i] = authorizationOverrides[i];
      } else if (legs[i].pool != address(0)) {
        // A zero-pool leg has no domain to sign against; it must reach the
        // resolver unsigned so the zero-address guard is what rejects it
        authorizations[i] = _authorize(
          authorizerPk,
          RelayFundingPool(legs[i].pool),
          legs[i].account,
          orderAddress
        );
      }
    }
    delete authorizationOverrides;

    preparedExecutionData = abi.encode(
      PoolDrawResolver.Execution({legs: legs, calls: calls, salt: salt})
    );
    preparedPayload = abi.encode(preparedExecutionData, authorizations);
    nonce = _commitmentNonce(address(drawResolver), preparedExecutionData);
  }

  /// @notice Signs `DrawAuthorization{account, orderAddress}` against the
  ///         domain of the pool the leg draws from, so a signature minted for
  ///         one pool cannot satisfy a leg naming another
  function _authorize(
    uint256 signerPk,
    RelayFundingPool legPool,
    address account,
    address orderAddress
  ) internal view returns (bytes memory signature) {
    bytes32 digest = legPool.hashDrawAuthorization(
      DrawAuthorization({account: account, orderAddress: orderAddress})
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
    signature = abi.encodePacked(r, s, v);
  }

  /// @notice Mirrors `PoolResolverBase._requirePayloadCommitment`
  function _commitmentNonce(
    address resolver,
    bytes memory payload
  ) internal pure returns (bytes32 nonce) {
    nonce = keccak256(abi.encodePacked(resolver, keccak256(payload)));
  }

  function _execute(ExecuteAndWithdrawRequest memory request) internal {
    executor.execute(
      request,
      address(drawResolver),
      preparedPayload,
      oracleSigner,
      _signRequest(request)
    );
  }

  function _fixedLeg(
    address account,
    address token,
    uint256 amount
  ) internal view returns (DrawLeg memory leg) {
    leg = _fixedLegIn(pool, account, token, amount);
  }

  function _fixedLegIn(
    RelayFundingPool legPool,
    address account,
    address token,
    uint256 amount
  ) internal pure returns (DrawLeg memory leg) {
    leg = DrawLeg({
      pool: address(legPool),
      account: account,
      kind: DrawLegKind.FIXED,
      tokenIn: token,
      tokenOut: token,
      amount: amount,
      amountOutMinimum: amount,
      calls: new Call[](0)
    });
  }

  function _shortfallLeg(
    address account,
    address token,
    uint256 target
  ) internal view returns (DrawLeg memory leg) {
    leg = _shortfallLegIn(pool, account, token, target);
  }

  function _shortfallLegIn(
    RelayFundingPool legPool,
    address account,
    address token,
    uint256 target
  ) internal pure returns (DrawLeg memory leg) {
    leg = DrawLeg({
      pool: address(legPool),
      account: account,
      kind: DrawLegKind.SHORTFALL_TO_TARGET,
      tokenIn: token,
      tokenOut: token,
      amount: target,
      amountOutMinimum: 0,
      calls: new Call[](0)
    });
  }

  function _depositHubToken(
    address account,
    uint256 tokenId,
    address tokenView,
    uint256 amount
  ) internal {
    _depositHubTokenIn(pool, account, tokenId, tokenView, amount);
  }

  function _depositHubTokenIn(
    RelayFundingPool targetPool,
    address account,
    uint256 tokenId,
    address tokenView,
    uint256 amount
  ) internal {
    vm.startPrank(owner);
    hub.mint(owner, tokenId, amount);
    ERC20View(tokenView).approve(address(targetPool), amount);
    targetPool.depositFor(account, tokenView, amount);
    vm.stopPrank();
  }

  function _configureAccount(
    address account,
    address token,
    uint256 perOrderCap
  ) internal {
    _configureAccountIn(pool, account, token, perOrderCap);
  }

  function _configureAccountIn(
    RelayFundingPool targetPool,
    address account,
    address token,
    uint256 perOrderCap
  ) internal {
    vm.startPrank(account);
    targetPool.setSponsorshipResolver(address(drawResolver), true);
    targetPool.setSponsorshipConfig(
      token,
      SponsorshipConfig({
        perOrderCap: perOrderCap,
        budget: UNLIMITED,
        authorizer: authorizer,
        expiry: 0
      })
    );
    vm.stopPrank();
  }

  function _request(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce
  ) internal view returns (ExecuteAndWithdrawRequest memory request) {
    request = ExecuteAndWithdrawRequest({
      inChainId: IN_CHAIN_ID,
      inCurrency: inCurrency,
      outChainId: OUT_CHAIN_ID,
      outCurrency: outCurrency,
      outAmountMinimum: outAmountMinimum,
      depository: abi.encodePacked(depository),
      orderAddress: orderAddress,
      receiver: abi.encodePacked(receiver),
      data: "",
      fees: new Fee[](0),
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _requestWithFee(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce,
    uint256 feeAmount
  ) internal view returns (ExecuteAndWithdrawRequest memory request) {
    Fee[] memory fees = new Fee[](1);
    fees[0] = Fee({recipient: feeRecipient, amount: feeAmount});
    request = ExecuteAndWithdrawRequest({
      inChainId: IN_CHAIN_ID,
      inCurrency: inCurrency,
      outChainId: OUT_CHAIN_ID,
      outCurrency: outCurrency,
      outAmountMinimum: outAmountMinimum,
      depository: abi.encodePacked(depository),
      orderAddress: orderAddress,
      receiver: abi.encodePacked(receiver),
      data: "",
      fees: fees,
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _hubSwap(
    uint256 inputTokenId,
    uint256 outputTokenId,
    uint256 amountIn,
    uint256 amountOut
  ) internal view returns (Call memory call_) {
    call_ = Call({
      to: address(hubSwapper),
      data: abi.encodeCall(
        DrawResolverHubSwapper.swap,
        (inputTokenId, outputTokenId, amountIn, amountOut)
      )
    });
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
        _hashFees(request.fees),
        request.nonce,
        request.deadline
      )
    );
    signature = Eip712.sign(oracleSignerPk, executorDomain, structHash);
  }

  function _hashFees(Fee[] memory fees) internal pure returns (bytes32 hash) {
    bytes32[] memory feeHashes = new bytes32[](fees.length);
    for (uint256 i; i < fees.length; ++i) {
      feeHashes[i] = keccak256(
        abi.encode(FEE_TYPEHASH, fees[i].recipient, fees[i].amount)
      );
    }
    hash = keccak256(abi.encodePacked(feeHashes));
  }
}
