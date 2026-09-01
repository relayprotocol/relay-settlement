// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";
import {
  BuildPayloadParams,
  IPayloadBuilder,
  RelayAllocator
} from "../../contracts/RelayAllocator.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {RelayExecutor} from "../../contracts/RelayExecutor.sol";
import {Utils} from "../../contracts/Utils.sol";
import {BasicCallResolver} from "../../contracts/call-resolvers/BasicCallResolver.sol";
import {
  ExecuteAndWithdrawRequest,
  Fee,
  ICallResolver
} from "../../contracts/call-resolvers/ICallResolver.sol";

contract MockPayloadBuilder is IPayloadBuilder {
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

contract RecordingCall {
  bool public called;
  bytes32 public value;

  function record(bytes32 value_) external {
    called = true;
    value = value_;
  }
}

contract MockHubSwap {
  RelayHub internal immutable HUB;

  constructor(RelayHub hub) {
    HUB = hub;
  }

  function swap(
    uint256 tokenInId,
    uint256 tokenOutId,
    uint256 sourceAmount,
    uint256 outputAmount
  ) external {
    require(
      HUB.transferFrom(msg.sender, address(this), tokenInId, sourceAmount)
    );
    HUB.mint(msg.sender, tokenOutId, outputAmount);
  }
}

// A fully custom, solver-controlled call resolver that embeds its own logic
// instead of running a generic list of calls. It swaps the entire funded input
// through the swapper and returns the resulting output to the caller.
contract CustomCallResolver is ICallResolver {
  RelayHub internal immutable HUB;
  MockHubSwap internal immutable SWAPPER;

  constructor(RelayHub hub, MockHubSwap swapper) {
    HUB = hub;
    SWAPPER = swapper;
  }

  function execute(
    ExecuteAndWithdrawRequest calldata request,
    bool,
    bytes calldata
  ) external {
    uint256 tokenInId = Utils.generateTokenId(
      request.inChainId,
      request.inCurrency
    );
    uint256 tokenOutId = Utils.generateTokenId(
      request.outChainId,
      request.outCurrency
    );

    uint256 input = HUB.balanceOf(address(this), tokenInId);
    SWAPPER.swap(tokenInId, tokenOutId, input, input);

    uint256 output = HUB.balanceOf(address(this), tokenOutId);
    require(HUB.transfer(msg.sender, tokenOutId, output));
  }
}

// A resolver that records the request context it is handed (including the
// feesCharged flag) before swapping and returning the output.
contract RecordingCallResolver is ICallResolver {
  RelayHub internal immutable HUB;
  MockHubSwap internal immutable SWAPPER;

  bool public lastFeesCharged;
  bytes32 public lastNonce;
  uint256 public lastOutAmountMinimum;
  uint256 public callCount;

  constructor(RelayHub hub, MockHubSwap swapper) {
    HUB = hub;
    SWAPPER = swapper;
  }

  function execute(
    ExecuteAndWithdrawRequest calldata request,
    bool feesCharged,
    bytes calldata
  ) external {
    lastFeesCharged = feesCharged;
    lastNonce = request.nonce;
    lastOutAmountMinimum = request.outAmountMinimum;
    ++callCount;

    uint256 tokenInId = Utils.generateTokenId(
      request.inChainId,
      request.inCurrency
    );
    uint256 tokenOutId = Utils.generateTokenId(
      request.outChainId,
      request.outCurrency
    );

    uint256 input = HUB.balanceOf(address(this), tokenInId);
    SWAPPER.swap(tokenInId, tokenOutId, input, input);

    uint256 output = HUB.balanceOf(address(this), tokenOutId);
    require(HUB.transfer(msg.sender, tokenOutId, output));
  }
}

contract RelayExecutorTest is BaseTest {
  string internal constant IN_CHAIN_ID = "ethereum-mainnet";
  string internal constant OUT_CHAIN_ID = "ethereum-mainnet";
  string internal constant SPENDER_CHAIN_ID = "relay";

  bytes32 internal constant EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "ExecuteAndWithdrawRequest(string inChainId,bytes inCurrency,string outChainId,bytes outCurrency,uint256 outAmountMinimum,bytes depository,address orderAddress,bytes receiver,bytes data,Fee[] fees,bytes32 nonce,uint256 deadline)Fee(address recipient,uint256 amount)"
    );

  bytes32 internal constant FEE_TYPEHASH =
    keccak256("Fee(address recipient,uint256 amount)");

  RelayHub internal hub;
  RelayAllocator internal allocator;
  RelayExecutor internal verifier;
  BasicCallResolver internal callResolver;
  MockPayloadBuilder internal payloadBuilder;

  address internal oracleSigner;
  uint256 internal oracleSignerPk;
  address internal relayer;
  address internal depository;
  address internal receiver;
  bytes internal inCurrency;
  bytes internal outCurrency;
  uint256 internal tokenInId;
  uint256 internal tokenOutId;
  bytes32 internal verifierDomain;

  function setUp() public override {
    super.setUp();
    (oracleSigner, oracleSignerPk) = makeAddrAndKey("oracleSigner");
    relayer = otherAccounts[0];
    depository = otherAccounts[1];
    receiver = otherAccounts[2];
    inCurrency = abi.encodePacked(address(0));
    outCurrency = abi.encodePacked(address(1));

    hub = new RelayHub(owner);
    allocator = new RelayAllocator(owner, address(hub), address(0xbeef));
    verifier = new RelayExecutor(owner, address(hub), address(allocator));
    callResolver = new BasicCallResolver(address(hub));
    payloadBuilder = new MockPayloadBuilder();

    vm.prank(owner);
    allocator.setPayloadBuilder(
      OUT_CHAIN_ID,
      abi.encodePacked(depository),
      address(payloadBuilder)
    );

    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.grantRole(hub.OPERATOR_ROLE(), address(verifier));
    hub.grantRole(hub.OPERATOR_ROLE(), address(allocator));
    verifier.grantRole(verifier.ORACLE_ROLE(), oracleSigner);
    vm.stopPrank();

    tokenInId = _tokenId(IN_CHAIN_ID, inCurrency);
    tokenOutId = _tokenId(OUT_CHAIN_ID, outCurrency);
    verifierDomain = Eip712.domainSeparator(
      "RelayExecutor",
      "1",
      block.chainid,
      address(verifier)
    );
  }

  function test_executesSignedSwapWithdrawRequestWithUnsignedCalls() public {
    address orderAddress = otherAccounts[3];
    uint256 amount = 120;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(1))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    RecordingCall target = new RecordingCall();
    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](2);
    calls[0] = BasicCallResolver.Call({
      to: address(target),
      data: abi.encodeCall(RecordingCall.record, (keccak256("called")))
    });
    calls[1] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(
        MockHubSwap.swap,
        (tokenInId, tokenOutId, amount, amount)
      )
    });

    vm.prank(relayer);
    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(request, amount);

    assertTrue(target.called());
    assertEq(target.value(), keccak256("called"));
    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(
      verifier.orderAddressByWithdrawRequestHash(withdrawRequestHash),
      orderAddress
    );
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), amount);
    assertEq(
      hub.balanceOf(
        _virtualAddress(SPENDER_CHAIN_ID, abi.encodePacked(address(verifier))),
        tokenOutId
      ),
      0
    );
    assertEq(
      keccak256(allocator.payloads(withdrawRequestHash)),
      keccak256(hex"01")
    );
  }

  function test_basicCallResolverSweepsSpecifiedTokenBalances() public {
    address caller = otherAccounts[6];
    address inputRecipient = otherAccounts[7];
    address outputRecipient = otherAccounts[8];
    uint256 emptyTokenId = _tokenId("empty-chain", abi.encodePacked(address(9)));
    vm.startPrank(owner);
    hub.mint(address(callResolver), tokenInId, 100);
    hub.mint(address(callResolver), tokenOutId, 75);
    vm.stopPrank();

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);
    BasicCallResolver.Sweep[] memory sweeps = new BasicCallResolver.Sweep[](3);
    sweeps[0] = BasicCallResolver.Sweep({
      recipient: inputRecipient,
      tokenId: tokenInId
    });
    sweeps[1] = BasicCallResolver.Sweep({
      recipient: outputRecipient,
      tokenId: tokenOutId
    });
    sweeps[2] = BasicCallResolver.Sweep({
      recipient: outputRecipient,
      tokenId: emptyTokenId
    });

    vm.prank(caller);
    callResolver.execute(
      _swapRequest(otherAccounts[3], 0, bytes32(uint256(81))),
      false,
      _encode(calls, sweeps)
    );

    assertEq(hub.balanceOf(address(callResolver), tokenInId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenOutId), 0);
    assertEq(hub.balanceOf(inputRecipient, tokenInId), 100);
    assertEq(hub.balanceOf(outputRecipient, tokenOutId), 75);
    assertEq(hub.balanceOf(outputRecipient, emptyTokenId), 0);
  }

  function test_usesPostSwapBalanceAsWithdrawAmount() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      95,
      bytes32(uint256(2))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 95))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(request, 95);

    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(
      verifier.orderAddressByWithdrawRequestHash(withdrawRequestHash),
      orderAddress
    );
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), 100);
  }

  function test_chargesFeesInInputCurrencyBeforeExecutingCalls() public {
    address orderAddress = otherAccounts[3];
    address feeRecipientA = otherAccounts[4];
    address feeRecipientB = otherAccounts[5];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    Fee[] memory fees = new Fee[](2);
    fees[0] = Fee({recipient: feeRecipientA, amount: 7});
    fees[1] = Fee({recipient: feeRecipientB, amount: 3});

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(6)),
      fees
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // Only the post-fee balance (90) is available to the swap call
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(request, 90);

    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(hub.balanceOf(feeRecipientA, tokenInId), 7);
    assertEq(hub.balanceOf(feeRecipientB, tokenInId), 3);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), 90);
  }

  function test_chargesFeesOnlyOncePerOrderAddress() public {
    address orderAddress = otherAccounts[3];
    address feeRecipient = otherAccounts[4];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    Fee[] memory fees = new Fee[](1);
    fees[0] = Fee({recipient: feeRecipient, amount: 10});

    // First execution charges the fee on the post-pull balance
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    ExecuteAndWithdrawRequest memory firstRequest = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(8)),
      fees
    );
    BasicCallResolver.Call[] memory firstCalls = new BasicCallResolver.Call[](
      1
    );
    firstCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });
    verifier.execute(
      firstRequest,
      address(callResolver),
      _encode(firstCalls),
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, firstRequest)
    );

    assertTrue(verifier.feesChargedByOrderAddress(orderAddress));
    assertEq(hub.balanceOf(feeRecipient, tokenInId), 10);

    // Re-fund the same order address and execute again with fees
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    ExecuteAndWithdrawRequest memory secondRequest = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(9)),
      fees
    );
    // No fee is charged the second time, so the full balance is swappable
    BasicCallResolver.Call[] memory secondCalls = new BasicCallResolver.Call[](
      1
    );
    secondCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(
      secondRequest,
      address(callResolver),
      _encode(secondCalls),
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, secondRequest)
    );

    // The fee recipient balance is unchanged after the second execution
    assertEq(hub.balanceOf(feeRecipient, tokenInId), 10);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
  }

  function test_revertsWhenFeesExceedOrderBalance() public {
    address orderAddress = otherAccounts[3];
    address feeRecipient = otherAccounts[4];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    Fee[] memory fees = new Fee[](1);
    fees[0] = Fee({recipient: feeRecipient, amount: 101});

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      0,
      bytes32(uint256(7)),
      fees
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);

    vm.expectRevert();
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );
  }

  function test_revertsWhenReplayingWithRefundedOrderAddress() public {
    address orderAddress = otherAccounts[3];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(42))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // First funding and execution succeeds
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    BasicCallResolver.Call[] memory firstCalls = new BasicCallResolver.Call[](
      1
    );
    firstCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(
      request,
      address(callResolver),
      _encode(firstCalls),
      oracleSigner,
      signature
    );

    // Re-fund the same order address with a different amount so the resulting
    // withdraw request hash would differ, then replay the same authorization
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 50);
    BasicCallResolver.Call[] memory secondCalls = new BasicCallResolver.Call[](
      1
    );
    secondCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 50, 50))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        _executeAndWithdrawRequestDigest(request)
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(secondCalls),
      oracleSigner,
      signature
    );

    // The order funds from the second funding remain untouched
    assertEq(hub.balanceOf(orderAddress, tokenInId), 50);
  }

  function test_revertsWhenReplayingWithDifferentCalls() public {
    address orderAddress = otherAccounts[3];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(43))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    BasicCallResolver.Call[] memory firstCalls = new BasicCallResolver.Call[](
      1
    );
    firstCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(
      request,
      address(callResolver),
      _encode(firstCalls),
      oracleSigner,
      signature
    );

    // Replay with calls that would produce a different tokenOut amount
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    BasicCallResolver.Call[] memory secondCalls = new BasicCallResolver.Call[](
      1
    );
    secondCalls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 95))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        _executeAndWithdrawRequestDigest(request)
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(secondCalls),
      oracleSigner,
      signature
    );
  }

  function test_marksRequestAsUsedAfterExecution() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(44))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    bytes32 digest = _executeAndWithdrawRequestDigest(request);
    assertFalse(verifier.usedRequests(digest));

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    assertTrue(verifier.usedRequests(digest));
  }

  function test_chargesFeesWithoutBlanketOperatorRole() public {
    // The executor pays fees out of its own pulled balance. To prove it does not
    // rely on a blanket Hub operator role (which would, for example, let it move
    // funds it does not hold), revoke that role and authorize the executor only
    // for the specific order address it must pull from.
    address orderAddress = otherAccounts[3];
    address feeRecipientA = otherAccounts[4];
    address feeRecipientB = otherAccounts[5];
    uint256 amount = 100;

    vm.startPrank(owner);
    hub.revokeRole(hub.OPERATOR_ROLE(), address(verifier));
    hub.mint(orderAddress, tokenInId, amount);
    vm.stopPrank();

    // The order address authorizes the executor to pull its funds
    vm.prank(orderAddress);
    hub.setOperator(address(verifier), true);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    Fee[] memory fees = new Fee[](2);
    fees[0] = Fee({recipient: feeRecipientA, amount: 7});
    fees[1] = Fee({recipient: feeRecipientB, amount: 3});

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(30)),
      fees
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // Only the post-fee balance (90) is available to the swap call
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(request, 90);

    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(hub.balanceOf(feeRecipientA, tokenInId), 7);
    assertEq(hub.balanceOf(feeRecipientB, tokenInId), 3);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenInId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), 90);
  }

  function test_feesAreNotChargedFromSandbox() public {
    // Fees must be taken from the funds the executor holds after the pull, never
    // from the sandbox. Assert the sandbox is only ever funded with the
    // post-fee amount by checking the amount the swap can pull from it.
    address orderAddress = otherAccounts[3];
    address feeRecipient = otherAccounts[4];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    Fee[] memory fees = new Fee[](1);
    fees[0] = Fee({recipient: feeRecipient, amount: 25});

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      75,
      bytes32(uint256(31)),
      fees
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // The sandbox only ever holds the post-fee amount (75); a swap that tries to
    // pull the full pre-fee amount (100) must fail for lack of funds.
    BasicCallResolver.Call[] memory tooMuch = new BasicCallResolver.Call[](1);
    tooMuch[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    vm.expectRevert();
    verifier.execute(
      request,
      address(callResolver),
      _encode(tooMuch),
      oracleSigner,
      signature
    );

    // Swapping exactly the post-fee amount succeeds, and the fee was paid
    BasicCallResolver.Call[] memory exact = new BasicCallResolver.Call[](1);
    exact[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 75, 75))
    });
    verifier.execute(
      request,
      address(callResolver),
      _encode(exact),
      oracleSigner,
      signature
    );

    assertEq(hub.balanceOf(feeRecipient, tokenInId), 25);
    assertEq(hub.balanceOf(address(swapper), tokenInId), 75);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenInId), 0);
  }

  function test_revertsWhenResolverDivertsInputWithoutReturningOutput() public {
    address orderAddress = otherAccounts[3];
    address attacker = otherAccounts[6];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      95,
      bytes32(uint256(20))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // The resolver can transfer away its funded input, but returning no output
    // fails the signed minimum-output check and reverts the entire transaction.
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(hub),
      data: abi.encodeCall(RelayHub.transfer, (attacker, tokenInId, amount))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InsufficientMinimumAmount.selector,
        tokenOutId,
        0,
        95
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    // The revert restores the order funds and every intermediate transfer.
    assertEq(hub.balanceOf(attacker, tokenInId), 0);
    assertEq(hub.balanceOf(orderAddress, tokenInId), amount);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenInId), 0);
  }

  function test_solverMayRetainInputWhenReturningMinimumOutput() public {
    address orderAddress = otherAccounts[3];
    address solverRevenueRecipient = otherAccounts[6];
    uint256 amountIn = 100;
    uint256 amountOutMinimum = 95;

    vm.startPrank(owner);
    hub.mint(orderAddress, tokenInId, amountIn);
    // The resolver independently sources the output floor.
    hub.mint(address(callResolver), tokenOutId, amountOutMinimum);
    vm.stopPrank();

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      amountOutMinimum,
      bytes32(uint256(22))
    );

    // Resolver choice and calldata are intentionally solver-controlled. This
    // plan retains the funded input as solver revenue and returns only the
    // oracle-signed minimum output to the executor.
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(hub),
      data: abi.encodeCall(
        RelayHub.transfer,
        (solverRevenueRecipient, tokenInId, amountIn)
      )
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, request)
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(
        request,
        amountOutMinimum
      );
    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(hub.balanceOf(solverRevenueRecipient, tokenInId), amountIn);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenInId), 0);
    assertEq(hub.balanceOf(address(callResolver), tokenOutId), 0);
  }

  function test_sandboxedCallsCannotUseExecutorPrivileges() public {
    address orderAddress = otherAccounts[3];
    address victim = otherAccounts[5];
    address attacker = otherAccounts[6];
    uint256 amount = 100;
    vm.startPrank(owner);
    hub.mint(orderAddress, tokenInId, amount);
    hub.mint(victim, tokenInId, amount);
    vm.stopPrank();

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      95,
      bytes32(uint256(21))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // The executor is a Hub operator, but the sandbox is not. A call trying to
    // pull another account's funds via the Hub's operator path fails because
    // msg.sender is the privilege-less sandbox, not the executor.
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(hub),
      data: abi.encodeCall(
        RelayHub.transferFrom,
        (victim, attacker, tokenInId, amount)
      )
    });

    vm.expectRevert();
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    // The victim's funds are untouched
    assertEq(hub.balanceOf(victim, tokenInId), amount);
    assertEq(hub.balanceOf(attacker, tokenInId), 0);
  }

  function test_revertsWhenSignedFieldsAreChanged() public {
    ExecuteAndWithdrawRequest memory request = _swapRequest(
      otherAccounts[3],
      100,
      bytes32(uint256(3))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    request.outAmountMinimum = 101;

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InvalidSignature.selector,
        oracleSigner
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );
  }

  function test_exposesCanonicalRequestHash() public view {
    ExecuteAndWithdrawRequest memory request = _swapRequest(
      otherAccounts[3],
      100,
      bytes32(uint256(73))
    );

    assertEq(
      verifier.hashExecuteAndWithdrawRequest(request),
      _executeAndWithdrawRequestDigest(request)
    );
  }

  function test_revertsWhenRequestIsExpired() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(70))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    vm.warp(request.deadline + 1);

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestExpired.selector,
        request.deadline
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    // The order funds are untouched
    assertEq(hub.balanceOf(orderAddress, tokenInId), 100);
  }

  function test_executesAtExactDeadline() public {
    address orderAddress = otherAccounts[3];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      amount,
      bytes32(uint256(71))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // Executing exactly at the deadline is still valid
    vm.warp(request.deadline);

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](1);
    calls[0] = BasicCallResolver.Call({
      to: address(swapper),
      data: abi.encodeCall(
        MockHubSwap.swap,
        (tokenInId, tokenOutId, amount, amount)
      )
    });
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );

    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), amount);
  }

  function test_revertsWhenDeadlineIsTampered() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(72))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // Extending the deadline past what the oracle signed must invalidate the
    // signature, otherwise an expired quote could be revived
    request.deadline = request.deadline + 1 days;

    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InvalidSignature.selector,
        oracleSigner
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );
  }

  function test_revertsWhenOutputIsBelowMinimum() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      101,
      bytes32(uint256(5))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    BasicCallResolver.Call[] memory calls = new BasicCallResolver.Call[](0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InsufficientMinimumAmount.selector,
        tokenOutId,
        0,
        101
      )
    );
    verifier.execute(
      request,
      address(callResolver),
      _encode(calls),
      oracleSigner,
      signature
    );
  }

  function test_executesWithSolverSuppliedCallResolver() public {
    address orderAddress = otherAccounts[3];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    // The solver deploys and supplies its own ICallResolver with bespoke
    // logic. It is not a Hub operator, so it can only ever move the funds the
    // executor pushes to it for this order.
    CustomCallResolver resolver = new CustomCallResolver(hub, swapper);

    ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      amount,
      bytes32(uint256(50))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      address(resolver),
      "",
      oracleSigner,
      signature
    );

    RelayAllocator.WithdrawRequest
      memory allocatorRequest = _allocatorWithdrawRequest(request, amount);

    assertEq(withdrawRequestHash, keccak256(abi.encode(allocatorRequest)));
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier), tokenOutId), 0);
    assertEq(hub.balanceOf(address(resolver), tokenInId), 0);
    assertEq(hub.balanceOf(address(resolver), tokenOutId), 0);
    assertEq(hub.balanceOf(address(swapper), tokenInId), amount);
  }

  function test_forwardsRequestAndFeesChargedFlagToResolver() public {
    address orderAddress = otherAccounts[3];
    address feeRecipient = otherAccounts[4];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    RecordingCallResolver resolver = new RecordingCallResolver(hub, swapper);

    Fee[] memory fees = new Fee[](1);
    fees[0] = Fee({recipient: feeRecipient, amount: 10});

    // First execution charges fees, so the resolver is told feesCharged == true
    // and receives the post-fee input (90)
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    ExecuteAndWithdrawRequest memory firstRequest = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(60)),
      fees
    );
    verifier.execute(
      firstRequest,
      address(resolver),
      "",
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, firstRequest)
    );

    assertTrue(resolver.lastFeesCharged());
    assertEq(resolver.lastNonce(), bytes32(uint256(60)));
    assertEq(resolver.lastOutAmountMinimum(), 90);

    // A later execution on the same order address does not charge fees again, so
    // the resolver is told feesCharged == false and receives the full input
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    ExecuteAndWithdrawRequest memory secondRequest = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(61)),
      fees
    );
    verifier.execute(
      secondRequest,
      address(resolver),
      "",
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, secondRequest)
    );

    assertFalse(resolver.lastFeesCharged());
    assertEq(resolver.lastNonce(), bytes32(uint256(61)));
    assertEq(resolver.lastOutAmountMinimum(), 100);
    assertEq(resolver.callCount(), 2);
  }

  function _swapRequest(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce
  ) internal view returns (ExecuteAndWithdrawRequest memory) {
    return _swapRequest(orderAddress, outAmountMinimum, nonce, _noFees());
  }

  function _swapRequest(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce,
    Fee[] memory fees
  ) internal view returns (ExecuteAndWithdrawRequest memory) {
    return
      ExecuteAndWithdrawRequest({
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

  function _noFees() internal pure returns (Fee[] memory) {
    return new Fee[](0);
  }

  function _encode(
    BasicCallResolver.Call[] memory calls
  ) internal view returns (bytes memory) {
    BasicCallResolver.Sweep[] memory sweeps = new BasicCallResolver.Sweep[](1);
    sweeps[0] = BasicCallResolver.Sweep({
      recipient: address(verifier),
      tokenId: tokenOutId
    });
    return _encode(calls, sweeps);
  }

  function _encode(
    BasicCallResolver.Call[] memory calls,
    BasicCallResolver.Sweep[] memory sweeps
  ) internal pure returns (bytes memory) {
    return abi.encode(calls, sweeps);
  }

  function _allocatorWithdrawRequest(
    ExecuteAndWithdrawRequest memory request,
    uint256 amount
  ) internal view returns (RelayAllocator.WithdrawRequest memory) {
    return
      RelayAllocator.WithdrawRequest({
        chainId: request.outChainId,
        depository: request.depository,
        currency: request.outCurrency,
        amount: amount,
        spenderChainId: SPENDER_CHAIN_ID,
        spender: abi.encodePacked(address(verifier)),
        receiver: request.receiver,
        data: request.data,
        nonce: request.nonce
      });
  }

  function _signExecuteAndWithdrawRequest(
    uint256 pk,
    ExecuteAndWithdrawRequest memory request
  ) internal view returns (bytes memory) {
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
    return Eip712.sign(pk, verifierDomain, structHash);
  }

  function _executeAndWithdrawRequestDigest(
    ExecuteAndWithdrawRequest memory request
  ) internal view returns (bytes32) {
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
    return Eip712.digest(verifierDomain, structHash);
  }

  function _hashFees(Fee[] memory fees) internal pure returns (bytes32) {
    bytes32[] memory feeHashes = new bytes32[](fees.length);
    for (uint256 i; i < fees.length; ++i) {
      feeHashes[i] = keccak256(
        abi.encode(FEE_TYPEHASH, fees[i].recipient, fees[i].amount)
      );
    }
    return keccak256(abi.encodePacked(feeHashes));
  }

  function _tokenId(
    string memory chainId,
    bytes memory currency
  ) internal pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(chainId, currency)));
  }

  function _virtualAddress(
    string memory chainId,
    bytes memory account
  ) internal pure returns (address) {
    return
      address(uint160(uint256(keccak256(abi.encodePacked(chainId, account)))));
  }
}
