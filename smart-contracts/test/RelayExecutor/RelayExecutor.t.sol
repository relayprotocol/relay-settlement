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

    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](2);
    calls[0] = RelayExecutor.Call({
      to: address(target),
      data: abi.encodeCall(RecordingCall.record, (keccak256("called")))
    });
    calls[1] = RelayExecutor.Call({
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

    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](1);
    calls[0] = RelayExecutor.Call({
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
    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](1);
    calls[0] = RelayExecutor.Call({
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
    RelayExecutor.Call[] memory firstCalls = new RelayExecutor.Call[](1);
    firstCalls[0] = RelayExecutor.Call({
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
    RelayExecutor.Call[] memory secondCalls = new RelayExecutor.Call[](1);
    secondCalls[0] = RelayExecutor.Call({
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
    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](0);

    vm.expectRevert();
    verifier.execute(request, calls, oracleSigner, signature);
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

    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](0);
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
    RelayExecutor.Call[] memory calls = new RelayExecutor.Call[](0);

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
