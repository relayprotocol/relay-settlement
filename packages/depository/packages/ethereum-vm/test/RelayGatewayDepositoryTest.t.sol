// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

import {RelayGatewayDepository} from "../src/RelayGatewayDepository.sol";
import {Call, CallResult} from "../src/utils/RelayDepositoryStructs.sol";
import {CallRequest} from "../src/utils/RelayGatewayDepositoryStructs.sol";
import {
  TestCircleGatewayMinter,
  TestCircleGatewayWallet
} from "./mocks/TestCircleGateway.sol";
import {TestERC20} from "./mocks/TestERC20.sol";

contract RelayGatewayDepositoryTest is Test {
  error Unauthorized();

  event RelayErc20Deposit(
    address from,
    address token,
    uint256 amount,
    bytes32 id
  );
  event RelayCallExecuted(bytes32 id, Call call);
  event DepositsEnabledSet(bool enabled);

  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
  bytes32 internal constant CALL_TYPEHASH =
    keccak256("Call(address to,bytes data,uint256 value,bool allowFailure)");
  bytes32 internal constant CALL_REQUEST_TYPEHASH =
    keccak256(
      "CallRequest(bytes32 transferSpecHash,Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
    );
  bytes4 internal constant TRANSFER_SPEC_MAGIC = 0xca85def7;
  bytes4 internal constant ATTESTATION_MAGIC = 0xff6fb334;
  bytes4 internal constant ATTESTATION_SET_MAGIC = 0x1e12db71;
  address internal constant GATEWAY_WALLET =
    0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;
  address internal constant GATEWAY_MINTER =
    0x2222222d7164433c4C09B0b0D809a9b52C04C205;

  Account internal allocator;
  Account internal alice;
  Account internal bob;
  TestERC20 internal usdc;
  TestERC20 internal otherToken;
  TestCircleGatewayWallet internal gatewayWallet;
  TestCircleGatewayMinter internal gatewayMinter;
  RelayGatewayDepository internal depository;

  function setUp() public {
    allocator = makeAccount("allocator");
    alice = makeAccount("alice");
    bob = makeAccount("bob");
    usdc = new TestERC20();
    otherToken = new TestERC20();
    gatewayWallet = _deployGatewayWalletMock();
    gatewayMinter = _deployGatewayMinterMock();
    depository = new RelayGatewayDepository(address(this), allocator.addr);
    depository.initializeUsdc(address(usdc));
    depository.setDepositsEnabled(true);
  }

  function test_usesCircleGatewayConstants() public view {
    assertEq(depository.GATEWAY_WALLET(), address(gatewayWallet));
    assertEq(depository.GATEWAY_MINTER(), address(gatewayMinter));
  }

  function test_initializesUsdc() public {
    RelayGatewayDepository uninitialized = new RelayGatewayDepository(
      address(this),
      allocator.addr
    );

    vm.expectEmit(address(uninitialized));
    emit RelayGatewayDepository.UsdcInitialized(address(usdc));
    uninitialized.initializeUsdc(address(usdc));

    assertEq(uninitialized.USDC(), address(usdc));
  }

  function test_rejectsUsdcReinitialization() public {
    vm.expectRevert(RelayGatewayDepository.UsdcAlreadyInitialized.selector);
    depository.initializeUsdc(address(otherToken));
  }

  function test_rejectsZeroUsdc() public {
    RelayGatewayDepository uninitialized = new RelayGatewayDepository(
      address(this),
      allocator.addr
    );

    vm.expectRevert(RelayGatewayDepository.AddressCannotBeZero.selector);
    uninitialized.initializeUsdc(address(0));
  }

  function test_rejectsUsdcInitializationFromNonOwner() public {
    RelayGatewayDepository uninitialized = new RelayGatewayDepository(
      address(this),
      allocator.addr
    );

    vm.prank(alice.addr);
    vm.expectRevert(Unauthorized.selector);
    uninitialized.initializeUsdc(address(usdc));
  }

  function test_rejectsDepositsBeforeUsdcInitialization() public {
    RelayGatewayDepository uninitialized = new RelayGatewayDepository(
      address(this),
      allocator.addr
    );
    uninitialized.setDepositsEnabled(true);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayGatewayDepository.InvalidToken.selector,
        address(usdc)
      )
    );
    uninitialized.depositErc20(
      alice.addr,
      address(usdc),
      1,
      bytes32(uint256(1))
    );
  }

  function test_startsWithDepositsDisabled() public {
    RelayGatewayDepository freshDepository = new RelayGatewayDepository(
      address(this),
      allocator.addr
    );

    assertFalse(freshDepository.depositsEnabled());
  }

  function test_setsDepositsEnabled() public {
    vm.expectEmit(true, true, true, true, address(depository));
    emit DepositsEnabledSet(false);
    depository.setDepositsEnabled(false);

    assertFalse(depository.depositsEnabled());

    vm.expectEmit(true, true, true, true, address(depository));
    emit DepositsEnabledSet(true);
    depository.setDepositsEnabled(true);

    assertTrue(depository.depositsEnabled());
  }

  function test_rejectsDepositsEnabledUpdateFromNonOwner() public {
    vm.prank(alice.addr);
    vm.expectRevert(Unauthorized.selector);
    depository.setDepositsEnabled(false);
  }

  function test_updatesAllocator() public {
    Account memory newAllocator = makeAccount("newAllocator");

    depository.setAllocator(newAllocator.addr);

    assertEq(depository.allocator(), newAllocator.addr);
  }

  function test_rejectsAllocatorUpdateFromNonOwner() public {
    Account memory newAllocator = makeAccount("newAllocator");

    vm.prank(alice.addr);
    vm.expectRevert(Unauthorized.selector);
    depository.setAllocator(newAllocator.addr);
  }

  function test_depositsUsdcIntoAllocatorGatewayBalance(uint96 amount) public {
    vm.assume(amount > 0);
    bytes32 id = bytes32(uint256(1));
    usdc.mint(alice.addr, amount);

    vm.prank(alice.addr);
    usdc.approve(address(depository), amount);

    vm.expectEmit(true, true, true, true, address(depository));
    emit RelayErc20Deposit(alice.addr, address(usdc), amount, id);

    vm.prank(alice.addr);
    depository.depositErc20(alice.addr, address(usdc), amount, id);

    assertEq(usdc.balanceOf(address(depository)), 0);
    assertEq(usdc.balanceOf(address(gatewayWallet)), amount);
    assertEq(usdc.allowance(address(depository), address(gatewayWallet)), 0);
    assertEq(gatewayWallet.balances(address(usdc), allocator.addr), amount);
  }

  function test_rejectsDepositWhenDepositsAreDisabled(uint96 amount) public {
    vm.assume(amount > 0);
    depository.setDepositsEnabled(false);
    usdc.mint(alice.addr, amount);

    vm.prank(alice.addr);
    usdc.approve(address(depository), amount);

    vm.prank(alice.addr);
    vm.expectRevert(RelayGatewayDepository.DepositsDisabled.selector);
    depository.depositErc20(
      alice.addr,
      address(usdc),
      amount,
      bytes32(uint256(1))
    );
  }

  function test_depositsIntoUpdatedAllocatorGatewayBalance(
    uint96 amount
  ) public {
    vm.assume(amount > 0);
    Account memory newAllocator = makeAccount("newAllocator");
    depository.setAllocator(newAllocator.addr);
    usdc.mint(alice.addr, amount);

    vm.prank(alice.addr);
    usdc.approve(address(depository), amount);

    vm.prank(alice.addr);
    depository.depositErc20(
      alice.addr,
      address(usdc),
      amount,
      bytes32(uint256(1))
    );

    assertEq(gatewayWallet.balances(address(usdc), newAllocator.addr), amount);
    assertEq(gatewayWallet.balances(address(usdc), allocator.addr), 0);
  }

  function test_depositsFullAllowanceAndCreditsCaller(uint96 amount) public {
    vm.assume(amount > 0);
    bytes32 id = bytes32(uint256(2));
    usdc.mint(alice.addr, amount);

    vm.prank(alice.addr);
    usdc.approve(address(depository), amount);

    vm.expectEmit(true, true, true, true, address(depository));
    emit RelayErc20Deposit(alice.addr, address(usdc), amount, id);

    vm.prank(alice.addr);
    depository.depositErc20(address(0), address(usdc), id);

    assertEq(gatewayWallet.balances(address(usdc), allocator.addr), amount);
  }

  function test_rejectsNonUsdcDeposit() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayGatewayDepository.InvalidToken.selector,
        address(otherToken)
      )
    );
    depository.depositErc20(
      alice.addr,
      address(otherToken),
      1,
      bytes32(uint256(1))
    );
  }

  function test_executesGatewayMintAndTransfer() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory signature = _sign(request, allocator.key);
    bytes memory attestation = _attestation(amount);

    vm.expectEmit(true, true, true, true, address(depository));
    emit RelayCallExecuted(_structHash(request), request.calls[0]);

    CallResult[] memory results = depository.execute(
      request,
      signature,
      attestation,
      hex"1234"
    );

    assertEq(results.length, 1);
    assertTrue(results[0].success);
    assertEq(usdc.balanceOf(alice.addr), amount);
    assertEq(usdc.balanceOf(address(depository)), 0);
    assertTrue(gatewayMinter.usedTransferSpecHashes(request.transferSpecHash));
    assertTrue(depository.callRequests(_structHash(request)));
  }

  function test_executesMultipleCalls() public {
    uint256 aliceAmount = 600_000;
    uint256 bobAmount = 400_000;
    uint256 totalAmount = aliceAmount + bobAmount;
    CallRequest memory request = _request(totalAmount);
    request.calls = new Call[](2);
    request.calls[0] = Call({
      to: address(usdc),
      data: abi.encodeWithSelector(
        usdc.transfer.selector,
        alice.addr,
        aliceAmount
      ),
      value: 0,
      allowFailure: false
    });
    request.calls[1] = Call({
      to: address(usdc),
      data: abi.encodeWithSelector(usdc.transfer.selector, bob.addr, bobAmount),
      value: 0,
      allowFailure: false
    });

    CallResult[] memory results = depository.execute(
      request,
      _sign(request, allocator.key),
      _attestation(totalAmount),
      hex"1234"
    );

    assertEq(results.length, 2);
    assertTrue(results[0].success);
    assertTrue(results[1].success);
    assertEq(usdc.balanceOf(alice.addr), aliceAmount);
    assertEq(usdc.balanceOf(bob.addr), bobAmount);
  }

  function test_rejectsInvalidAllocatorSignature() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory signature = _sign(request, alice.key);

    vm.expectRevert(RelayGatewayDepository.InvalidSignature.selector);
    depository.execute(request, signature, _attestation(amount), hex"1234");
  }

  function test_rejectsExpiredCallRequest() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    request.expiration = block.timestamp - 1;

    vm.expectRevert(RelayGatewayDepository.CallRequestExpired.selector);
    depository.execute(
      request,
      _sign(request, allocator.key),
      _attestation(amount),
      hex"1234"
    );
  }

  function test_rejectsUsedCallRequest() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory signature = _sign(request, allocator.key);
    bytes memory attestation = _attestation(amount);
    depository.execute(request, signature, attestation, hex"1234");

    vm.expectRevert(RelayGatewayDepository.CallRequestAlreadyUsed.selector);
    depository.execute(request, signature, attestation, hex"1234");
  }

  function test_rejectsPreviouslyUsedTransferSpec() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    gatewayMinter.setTransferSpecHashUsed(request.transferSpecHash);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayGatewayDepository.TransferSpecHashAlreadyUsed.selector,
        request.transferSpecHash
      )
    );
    depository.execute(
      request,
      _sign(request, allocator.key),
      _attestation(amount),
      hex"1234"
    );
  }

  function test_rejectsAttestationForDifferentTransferSpec() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory otherTransferSpec = _transferSpec(amount + 1);
    bytes32 otherTransferSpecHash = keccak256(otherTransferSpec);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayGatewayDepository.GatewayAttestationTransferSpecMismatch.selector,
        request.transferSpecHash,
        otherTransferSpecHash
      )
    );
    depository.execute(
      request,
      _sign(request, allocator.key),
      _attestation(otherTransferSpec),
      hex"1234"
    );

    assertFalse(gatewayMinter.usedTransferSpecHashes(otherTransferSpecHash));
    assertFalse(depository.callRequests(_structHash(request)));
    assertEq(usdc.balanceOf(address(depository)), 0);
    assertEq(gatewayMinter.mintCallCount(), 0);
  }

  function test_rejectsAttestationSetBeforeMinting() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory firstAttestation = _attestation(amount);
    bytes memory secondTransferSpec = _transferSpec(amount + 1);
    bytes32 secondTransferSpecHash = keccak256(secondTransferSpec);
    bytes memory secondAttestation = _attestation(secondTransferSpec);

    vm.expectRevert(
      RelayGatewayDepository.GatewayAttestationSetsNotSupported.selector
    );
    depository.execute(
      request,
      _sign(request, allocator.key),
      _attestationSet(firstAttestation, secondAttestation),
      hex"1234"
    );

    assertFalse(gatewayMinter.usedTransferSpecHashes(request.transferSpecHash));
    assertFalse(gatewayMinter.usedTransferSpecHashes(secondTransferSpecHash));
    assertFalse(depository.callRequests(_structHash(request)));
    assertEq(usdc.balanceOf(address(depository)), 0);
    assertEq(gatewayMinter.mintCallCount(), 0);
  }

  function test_rejectsSingleElementAttestationSet() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);

    vm.expectRevert(
      RelayGatewayDepository.GatewayAttestationSetsNotSupported.selector
    );
    depository.execute(
      request,
      _sign(request, allocator.key),
      abi.encodePacked(ATTESTATION_SET_MAGIC, uint32(1), _attestation(amount)),
      hex"1234"
    );

    assertEq(gatewayMinter.mintCallCount(), 0);
  }

  function test_rejectsMalformedAttestationLength() public {
    uint256 amount = 1_000_000;
    CallRequest memory request = _request(amount);
    bytes memory malformedAttestation = bytes.concat(
      _attestation(amount),
      hex"00"
    );

    vm.expectRevert(
      RelayGatewayDepository.InvalidGatewayAttestationEncoding.selector
    );
    depository.execute(
      request,
      _sign(request, allocator.key),
      malformedAttestation,
      hex"1234"
    );

    assertEq(gatewayMinter.mintCallCount(), 0);
  }

  function _request(uint256 amount) internal view returns (CallRequest memory) {
    Call[] memory calls = new Call[](1);
    calls[0] = Call({
      to: address(usdc),
      data: abi.encodeWithSelector(usdc.transfer.selector, alice.addr, amount),
      value: 0,
      allowFailure: false
    });

    return
      CallRequest({
        transferSpecHash: keccak256(_transferSpec(amount)),
        calls: calls,
        nonce: 123,
        expiration: block.timestamp + 1 hours
      });
  }

  function _deployGatewayWalletMock()
    internal
    returns (TestCircleGatewayWallet)
  {
    TestCircleGatewayWallet wallet = new TestCircleGatewayWallet();
    vm.etch(GATEWAY_WALLET, address(wallet).code);
    return TestCircleGatewayWallet(GATEWAY_WALLET);
  }

  function _deployGatewayMinterMock()
    internal
    returns (TestCircleGatewayMinter)
  {
    TestCircleGatewayMinter minter = new TestCircleGatewayMinter(address(usdc));
    vm.etch(GATEWAY_MINTER, address(minter).code);
    return TestCircleGatewayMinter(GATEWAY_MINTER);
  }

  function _transferSpec(uint256 amount) internal view returns (bytes memory) {
    bytes memory header = abi.encodePacked(
      TRANSFER_SPEC_MAGIC,
      uint32(1),
      uint32(7),
      uint32(6),
      bytes32(0),
      bytes32(0),
      bytes32(0),
      bytes32(uint256(uint160(address(usdc)))),
      bytes32(0)
    );
    bytes memory footer = abi.encodePacked(
      bytes32(uint256(uint160(address(depository)))),
      bytes32(uint256(uint160(allocator.addr))),
      bytes32(uint256(uint160(address(depository)))),
      amount,
      keccak256(abi.encode(amount, alice.addr, uint256(123))),
      uint32(32),
      bytes32(uint256(123))
    );
    return bytes.concat(header, footer);
  }

  function _attestation(uint256 amount) internal view returns (bytes memory) {
    return _attestation(_transferSpec(amount));
  }

  function _attestation(
    bytes memory transferSpec
  ) internal pure returns (bytes memory) {
    return
      abi.encodePacked(
        ATTESTATION_MAGIC,
        type(uint256).max,
        uint32(transferSpec.length),
        transferSpec
      );
  }

  function _attestationSet(
    bytes memory first,
    bytes memory second
  ) internal pure returns (bytes memory) {
    return
      bytes.concat(
        abi.encodePacked(ATTESTATION_SET_MAGIC, uint32(2)),
        first,
        second
      );
  }

  function _sign(
    CallRequest memory request,
    uint256 privateKey
  ) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _eip712Hash(request));
    return bytes.concat(r, s, bytes1(v));
  }

  function _eip712Hash(
    CallRequest memory request
  ) internal view returns (bytes32) {
    bytes32 domainSeparator = keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256("RelayGatewayDepository"),
        keccak256("1"),
        block.chainid,
        address(depository)
      )
    );
    return
      keccak256(
        abi.encodePacked("\x19\x01", domainSeparator, _structHash(request))
      );
  }

  function _structHash(
    CallRequest memory request
  ) internal pure returns (bytes32) {
    bytes32[] memory callHashes = new bytes32[](request.calls.length);
    for (uint256 i = 0; i < request.calls.length; i++) {
      callHashes[i] = keccak256(
        abi.encode(
          CALL_TYPEHASH,
          request.calls[i].to,
          keccak256(request.calls[i].data),
          request.calls[i].value,
          request.calls[i].allowFailure
        )
      );
    }

    return
      keccak256(
        abi.encode(
          CALL_REQUEST_TYPEHASH,
          request.transferSpecHash,
          keccak256(abi.encodePacked(callHashes)),
          request.nonce,
          request.expiration
        )
      );
  }
}
