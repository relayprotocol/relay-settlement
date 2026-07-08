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
import {RelayCallExecutor} from "../../contracts/RelayCallExecutor.sol";

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

contract RelayExecutorTest is BaseTest {
  string internal constant IN_CHAIN_ID = "ethereum-mainnet";
  string internal constant OUT_CHAIN_ID = "ethereum-mainnet";
  string internal constant SPENDER_CHAIN_ID = "relay";

  bytes32 internal constant EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "ExecuteAndWithdrawRequest(string inChainId,bytes inCurrency,string outChainId,bytes outCurrency,uint256 outAmountMinimum,bytes depository,address orderAddress,bytes receiver,bytes data,Fee[] fees,bytes32 nonce)Fee(address recipient,uint256 amount)"
    );

  bytes32 internal constant FEE_TYPEHASH =
    keccak256("Fee(address recipient,uint256 amount)");

  RelayHub internal hub;
  RelayAllocator internal allocator;
  RelayExecutor internal verifier;
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

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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

    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](2);
    calls[0] = RelayCallExecutor.Call({
      to: address(target),
      data: abi.encodeCall(RecordingCall.record, (keccak256("called")))
    });
    calls[1] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(
        MockHubSwap.swap,
        (tokenInId, tokenOutId, amount, amount)
      )
    });

    vm.prank(relayer);
    bytes32 withdrawRequestHash = verifier.execute(
      request,
      calls,
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

  function test_usesPostSwapBalanceAsWithdrawAmount() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      95,
      bytes32(uint256(2))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 95))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      calls,
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

    RelayExecutor.Fee[] memory fees = new RelayExecutor.Fee[](2);
    fees[0] = RelayExecutor.Fee({recipient: feeRecipientA, amount: 7});
    fees[1] = RelayExecutor.Fee({recipient: feeRecipientB, amount: 3});

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      calls,
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

    RelayExecutor.Fee[] memory fees = new RelayExecutor.Fee[](1);
    fees[0] = RelayExecutor.Fee({recipient: feeRecipient, amount: 10});

    // First execution charges the fee on the post-pull balance
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    RelayExecutor.ExecuteAndWithdrawRequest memory firstRequest = _swapRequest(
      orderAddress,
      90,
      bytes32(uint256(8)),
      fees
    );
    RelayCallExecutor.Call[] memory firstCalls = new RelayCallExecutor.Call[](1);
    firstCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });
    verifier.execute(
      firstRequest,
      firstCalls,
      oracleSigner,
      _signExecuteAndWithdrawRequest(oracleSignerPk, firstRequest)
    );

    assertTrue(verifier.feesChargedByOrderAddress(orderAddress));
    assertEq(hub.balanceOf(feeRecipient, tokenInId), 10);

    // Re-fund the same order address and execute again with fees
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    RelayExecutor.ExecuteAndWithdrawRequest memory secondRequest = _swapRequest(
      orderAddress,
      100,
      bytes32(uint256(9)),
      fees
    );
    // No fee is charged the second time, so the full balance is swappable
    RelayCallExecutor.Call[] memory secondCalls = new RelayCallExecutor.Call[](1);
    secondCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(
      secondRequest,
      secondCalls,
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

    RelayExecutor.Fee[] memory fees = new RelayExecutor.Fee[](1);
    fees[0] = RelayExecutor.Fee({recipient: feeRecipient, amount: 101});

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      0,
      bytes32(uint256(7)),
      fees
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](0);

    vm.expectRevert();
    verifier.execute(request, calls, oracleSigner, signature);
  }

  function test_revertsWhenReplayingWithRefundedOrderAddress() public {
    address orderAddress = otherAccounts[3];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory firstCalls = new RelayCallExecutor.Call[](1);
    firstCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(request, firstCalls, oracleSigner, signature);

    // Re-fund the same order address with a different amount so the resulting
    // withdraw request hash would differ, then replay the same authorization
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 50);
    RelayCallExecutor.Call[] memory secondCalls = new RelayCallExecutor.Call[](1);
    secondCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 50, 50))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        _executeAndWithdrawRequestDigest(request)
      )
    );
    verifier.execute(request, secondCalls, oracleSigner, signature);

    // The order funds from the second funding remain untouched
    assertEq(hub.balanceOf(orderAddress, tokenInId), 50);
  }

  function test_revertsWhenReplayingWithDifferentCalls() public {
    address orderAddress = otherAccounts[3];

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory firstCalls = new RelayCallExecutor.Call[](1);
    firstCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(request, firstCalls, oracleSigner, signature);

    // Replay with calls that would produce a different tokenOut amount
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);
    RelayCallExecutor.Call[] memory secondCalls = new RelayCallExecutor.Call[](1);
    secondCalls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 95))
    });

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.RequestAlreadyExecuted.selector,
        _executeAndWithdrawRequestDigest(request)
      )
    );
    verifier.execute(request, secondCalls, oracleSigner, signature);
  }

  function test_marksRequestAsUsedAfterExecution() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    MockHubSwap swapper = new MockHubSwap(hub);
    bytes32 operatorRole = hub.OPERATOR_ROLE();
    vm.prank(owner);
    hub.grantRole(operatorRole, address(swapper));

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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

    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    verifier.execute(request, calls, oracleSigner, signature);

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

    RelayExecutor.Fee[] memory fees = new RelayExecutor.Fee[](2);
    fees[0] = RelayExecutor.Fee({recipient: feeRecipientA, amount: 7});
    fees[1] = RelayExecutor.Fee({recipient: feeRecipientB, amount: 3});

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 90, 90))
    });

    bytes32 withdrawRequestHash = verifier.execute(
      request,
      calls,
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
    assertEq(hub.balanceOf(address(verifier.CALL_EXECUTOR()), tokenInId), 0);
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

    RelayExecutor.Fee[] memory fees = new RelayExecutor.Fee[](1);
    fees[0] = RelayExecutor.Fee({recipient: feeRecipient, amount: 25});

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory tooMuch = new RelayCallExecutor.Call[](1);
    tooMuch[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 100, 100))
    });
    vm.expectRevert();
    verifier.execute(request, tooMuch, oracleSigner, signature);

    // Swapping exactly the post-fee amount succeeds, and the fee was paid
    RelayCallExecutor.Call[] memory exact = new RelayCallExecutor.Call[](1);
    exact[0] = RelayCallExecutor.Call({
      to: address(swapper),
      data: abi.encodeCall(MockHubSwap.swap, (tokenInId, tokenOutId, 75, 75))
    });
    verifier.execute(request, exact, oracleSigner, signature);

    assertEq(hub.balanceOf(feeRecipient, tokenInId), 25);
    assertEq(hub.balanceOf(address(swapper), tokenInId), 75);
    assertEq(hub.balanceOf(orderAddress, tokenInId), 0);
    assertEq(hub.balanceOf(address(verifier.CALL_EXECUTOR()), tokenInId), 0);
  }

  function test_maliciousCallDivertingInputRevertsBelowMinimum() public {
    address orderAddress = otherAccounts[3];
    address attacker = otherAccounts[6];
    uint256 amount = 100;
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, amount);

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      95,
      bytes32(uint256(20))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );

    // A malicious call tries to divert the sandboxed input funds to the attacker.
    // The sandbox holds the funds (msg.sender == sandbox), so the transfer would
    // succeed on its own, but it leaves no output, so the minimum-output check
    // reverts the entire transaction.
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
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
    verifier.execute(request, calls, oracleSigner, signature);

    // Nothing was stolen and the order funds are restored by the revert
    assertEq(hub.balanceOf(attacker, tokenInId), 0);
    assertEq(hub.balanceOf(orderAddress, tokenInId), amount);
    assertEq(hub.balanceOf(address(verifier), tokenInId), 0);
    assertEq(
      hub.balanceOf(address(verifier.CALL_EXECUTOR()), tokenInId),
      0
    );
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

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
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
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](1);
    calls[0] = RelayCallExecutor.Call({
      to: address(hub),
      data: abi.encodeCall(
        RelayHub.transferFrom,
        (victim, attacker, tokenInId, amount)
      )
    });

    vm.expectRevert();
    verifier.execute(request, calls, oracleSigner, signature);

    // The victim's funds are untouched
    assertEq(hub.balanceOf(victim, tokenInId), amount);
    assertEq(hub.balanceOf(attacker, tokenInId), 0);
  }

  function test_revertsWhenSignedFieldsAreChanged() public {
    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
      otherAccounts[3],
      100,
      bytes32(uint256(3))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    request.outAmountMinimum = 101;

    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](0);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InvalidSignature.selector,
        oracleSigner
      )
    );
    verifier.execute(request, calls, oracleSigner, signature);
  }

  function test_revertsWhenOutputIsBelowMinimum() public {
    address orderAddress = otherAccounts[3];
    vm.prank(owner);
    hub.mint(orderAddress, tokenInId, 100);

    RelayExecutor.ExecuteAndWithdrawRequest memory request = _swapRequest(
      orderAddress,
      101,
      bytes32(uint256(5))
    );
    bytes memory signature = _signExecuteAndWithdrawRequest(
      oracleSignerPk,
      request
    );
    RelayCallExecutor.Call[] memory calls = new RelayCallExecutor.Call[](0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayExecutor.InsufficientMinimumAmount.selector,
        tokenOutId,
        0,
        101
      )
    );
    verifier.execute(request, calls, oracleSigner, signature);
  }

  function _swapRequest(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce
  ) internal view returns (RelayExecutor.ExecuteAndWithdrawRequest memory) {
    return _swapRequest(orderAddress, outAmountMinimum, nonce, _noFees());
  }

  function _swapRequest(
    address orderAddress,
    uint256 outAmountMinimum,
    bytes32 nonce,
    RelayExecutor.Fee[] memory fees
  ) internal view returns (RelayExecutor.ExecuteAndWithdrawRequest memory) {
    return
      RelayExecutor.ExecuteAndWithdrawRequest({
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
        nonce: nonce
      });
  }

  function _noFees() internal pure returns (RelayExecutor.Fee[] memory) {
    return new RelayExecutor.Fee[](0);
  }

  function _allocatorWithdrawRequest(
    RelayExecutor.ExecuteAndWithdrawRequest memory request,
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
    RelayExecutor.ExecuteAndWithdrawRequest memory request
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
        request.nonce
      )
    );
    return Eip712.sign(pk, verifierDomain, structHash);
  }

  function _executeAndWithdrawRequestDigest(
    RelayExecutor.ExecuteAndWithdrawRequest memory request
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
        request.nonce
      )
    );
    return Eip712.digest(verifierDomain, structHash);
  }

  function _hashFees(
    RelayExecutor.Fee[] memory fees
  ) internal pure returns (bytes32) {
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
