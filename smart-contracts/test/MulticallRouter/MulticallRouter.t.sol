// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MyToken} from "../../contracts/test-utils/MyToken.sol";
import {Call} from "../../contracts/routers/IMulticallRouter.sol";
import {MulticallRouter} from "../../contracts/routers/MulticallRouter.sol";

/// @notice Records the order and value of incoming calls
contract CallRecorder {
  uint256[] public ids;
  uint256[] public values;

  function ping(uint256 id) external payable {
    ids.push(id);
    values.push(msg.value);
  }

  function idsLength() external view returns (uint256) {
    return ids.length;
  }
}

/// @notice Always reverts, used to exercise allowFailure handling
contract Reverter {
  error Boom();

  fallback() external payable {
    revert Boom();
  }
}

/// @notice Re-enters the router's multicall from an inner call
contract Reentrant {
  MulticallRouter public immutable ROUTER;

  constructor(MulticallRouter _router) {
    ROUTER = _router;
  }

  function reenter() external {
    ROUTER.multicall(new Call[](0));
  }
}

/// @notice Pre-funded pool that pays out a token on request, simulating a swap leg
contract MockPool {
  function give(address token, address to, uint256 amount) external {
    MyToken(token).transfer(to, amount);
  }
}

/// @notice Pulls approved tokens via transferFrom, simulating a DEX taking an allowance
contract TokenPuller {
  function pull(address token, address from, uint256 amount) external {
    MyToken(token).transferFrom(from, address(this), amount);
  }
}

/// @notice Access control, call execution, settlement, and residual-sweep checks
/// for MulticallRouter
contract MulticallRouterTest is Test {
  MulticallRouter internal router;
  MyToken internal tokenA;
  MyToken internal tokenB;

  address internal admin;
  address internal depository;
  address internal recipient;
  // Cached because reading it inside a `vm.prank`/`vm.expectRevert` argument would
  // consume the prank
  bytes32 internal adminRole;
  bytes32 internal depositoryRole;

  function setUp() public {
    admin = makeAddr("admin");
    depository = makeAddr("depository");
    recipient = makeAddr("recipient");

    router = new MulticallRouter(admin);
    tokenA = new MyToken();
    tokenB = new MyToken();
    adminRole = router.ADMIN_ROLE();
    depositoryRole = router.DEPOSITORY_ROLE();

    vm.prank(admin);
    router.grantRole(depositoryRole, depository);
  }

  function _unauthorized(
    address account,
    bytes32 role
  ) internal pure returns (bytes memory) {
    return
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        account,
        role
      );
  }

  function _single(
    address to,
    bytes memory data,
    uint256 value,
    bool allowFailure
  ) internal pure returns (Call[] memory calls) {
    calls = new Call[](1);
    calls[0] = Call({
      to: to,
      data: data,
      value: value,
      allowFailure: allowFailure
    });
  }

  function _sweepCall(
    address[] memory currencies,
    address to
  ) internal view returns (Call memory) {
    return
      Call({
        to: address(router),
        data: abi.encodeCall(MulticallRouter.sweep, (currencies, to)),
        value: 0,
        allowFailure: false
      });
  }

  function _currencies(
    address a
  ) internal pure returns (address[] memory currencies) {
    currencies = new address[](1);
    currencies[0] = a;
  }

  function _currencies(
    address a,
    address b
  ) internal pure returns (address[] memory currencies) {
    currencies = new address[](2);
    currencies[0] = a;
    currencies[1] = b;
  }

  function testMulticallRevertsForUnauthorizedCallers() public {
    Call[] memory calls = new Call[](0);
    address eoa = makeAddr("eoa");
    address pool = address(new MockPool());

    // EOA which was never granted the role
    vm.prank(eoa);
    vm.expectRevert(_unauthorized(eoa, depositoryRole));
    router.multicall(calls);

    // Unauthorized contract
    vm.prank(pool);
    vm.expectRevert(_unauthorized(pool, depositoryRole));
    router.multicall(calls);
  }

  function testMulticallSupportsMultipleDepositoriesAndRevocation() public {
    address secondDepository = makeAddr("secondDepository");

    vm.prank(admin);
    router.grantRole(depositoryRole, secondDepository);

    Call[] memory calls = new Call[](0);
    vm.prank(depository);
    router.multicall(calls);
    vm.prank(secondDepository);
    router.multicall(calls);

    vm.prank(admin);
    router.revokeRole(depositoryRole, depository);

    vm.prank(depository);
    vm.expectRevert(_unauthorized(depository, depositoryRole));
    router.multicall(calls);
  }

  function testConstructorWiresRoles() public view {
    assertTrue(router.hasRole(adminRole, admin));
    assertFalse(router.hasRole(depositoryRole, admin));
    assertEq(router.getRoleAdmin(adminRole), adminRole);
    assertEq(router.getRoleAdmin(depositoryRole), adminRole);
  }

  function testConstructorRejectsZeroAdmin() public {
    vm.expectRevert(MulticallRouter.ZeroAddress.selector);
    new MulticallRouter(address(0));
  }

  function testOnlyAdminCanGrantDepositoryRole() public {
    address eoa = makeAddr("eoa");

    vm.prank(eoa);
    vm.expectRevert(_unauthorized(eoa, adminRole));
    router.grantRole(depositoryRole, makeAddr("depository2"));

    // A depository cannot enrol another depository either
    vm.prank(depository);
    vm.expectRevert(_unauthorized(depository, adminRole));
    router.grantRole(depositoryRole, makeAddr("depository2"));
  }

  function testAdminCanRotateAdminRole() public {
    address secondAdmin = makeAddr("secondAdmin");
    address eoa = makeAddr("eoa");

    vm.prank(eoa);
    vm.expectRevert(_unauthorized(eoa, adminRole));
    router.grantRole(adminRole, makeAddr("evil"));

    vm.prank(admin);
    router.grantRole(adminRole, secondAdmin);
    vm.prank(secondAdmin);
    router.revokeRole(adminRole, admin);

    assertFalse(router.hasRole(adminRole, admin));
    vm.prank(secondAdmin);
    router.grantRole(depositoryRole, makeAddr("depository2"));
    assertTrue(router.hasRole(depositoryRole, makeAddr("depository2")));
  }

  function testMulticallExecutesCallsInOrderWithValues() public {
    CallRecorder recorder = new CallRecorder();
    vm.deal(address(router), 3 ether);

    Call[] memory calls = new Call[](2);
    calls[0] = Call({
      to: address(recorder),
      data: abi.encodeCall(CallRecorder.ping, (7)),
      value: 1 ether,
      allowFailure: false
    });
    calls[1] = Call({
      to: address(recorder),
      data: abi.encodeCall(CallRecorder.ping, (8)),
      value: 2 ether,
      allowFailure: false
    });

    vm.prank(depository);
    router.multicall(calls);

    assertEq(recorder.idsLength(), 2);
    assertEq(recorder.ids(0), 7);
    assertEq(recorder.ids(1), 8);
    assertEq(recorder.values(0), 1 ether);
    assertEq(recorder.values(1), 2 ether);
    assertEq(address(router).balance, 0);
  }

  function testMulticallHonorsAllowFailure() public {
    CallRecorder recorder = new CallRecorder();

    Call[] memory calls = new Call[](2);
    calls[0] = Call({
      to: address(new Reverter()),
      data: hex"",
      value: 0,
      allowFailure: true
    });
    calls[1] = Call({
      to: address(recorder),
      data: abi.encodeCall(CallRecorder.ping, (1)),
      value: 0,
      allowFailure: false
    });

    vm.prank(depository);
    router.multicall(calls);

    assertEq(recorder.idsLength(), 1);
  }

  function testMulticallRevertsOnDisallowedFailure() public {
    Call[] memory calls = _single(address(new Reverter()), hex"", 0, false);

    vm.prank(depository);
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.CallFailed.selector,
        abi.encodeWithSelector(Reverter.Boom.selector)
      )
    );
    router.multicall(calls);
  }

  function testMulticallBlocksReentrancy() public {
    Reentrant reentrant = new Reentrant(router);

    // Enrol the re-entering contract so only the reentrancy guard stops it
    vm.prank(admin);
    router.grantRole(depositoryRole, address(reentrant));

    Call[] memory calls = _single(
      address(reentrant),
      abi.encodeCall(Reentrant.reenter, ()),
      0,
      false
    );

    vm.prank(address(reentrant));
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.CallFailed.selector,
        abi.encodeWithSignature("ReentrancyGuardReentrantCall()")
      )
    );
    router.multicall(calls);
  }

  function testSweepRevertsForExternalCallers() public {
    vm.prank(depository);
    vm.expectRevert(MulticallRouter.CallerNotSelf.selector);
    router.sweep(_currencies(address(tokenA)), recipient);
  }

  function testSweepRevertsOnZeroRecipient() public {
    vm.prank(address(router));
    vm.expectRevert(MulticallRouter.InvalidRecipient.selector);
    router.sweep(_currencies(address(tokenA)), address(0));
  }

  function testSettleRevertsOnZeroRecipient() public {
    vm.deal(address(router), 1 ether);

    vm.prank(address(router));
    vm.expectRevert(MulticallRouter.InvalidRecipient.selector);
    router.settle(address(0), address(0), 0);
  }

  function testSettleOnZeroBalanceAtZeroMinimum() public {
    // The reason the sweep helper exists: a zero-minimum settle is not a safe
    // substitute, it still transfers on a zero balance
    vm.prank(address(router));
    router.settle(address(tokenA), recipient, 0);

    assertEq(tokenA.balanceOf(recipient), 0);
  }

  function testSweepTransfersDeclaredCurrenciesAndNative() public {
    tokenA.mintFor(50, address(router));
    vm.deal(address(router), 1 ether);

    Call[] memory calls = new Call[](1);
    calls[0] = _sweepCall(_currencies(address(tokenA), address(0)), recipient);

    vm.prank(depository);
    router.multicall(calls);

    assertEq(tokenA.balanceOf(recipient), 50);
    assertEq(tokenA.balanceOf(address(router)), 0);
    assertEq(recipient.balance, 1 ether);
    assertEq(address(router).balance, 0);
  }

  function testSweepSkipsZeroBalances() public {
    // Neither currency has any balance; the sweep must be a clean no-op
    Call[] memory calls = new Call[](1);
    calls[0] = _sweepCall(_currencies(address(tokenA), address(0)), recipient);

    vm.prank(depository);
    router.multicall(calls);

    assertEq(tokenA.balanceOf(recipient), 0);
    assertEq(recipient.balance, 0);
  }

  function testApprovalsSurviveButSweepLeavesNothingToDrain() public {
    TokenPuller puller = new TokenPuller();
    tokenA.mintFor(500, address(router));

    Call[] memory calls = new Call[](2);
    // Inner calls may approve freely, including an unlimited standing allowance
    calls[0] = Call({
      to: address(tokenA),
      data: abi.encodeCall(
        IERC20.approve,
        (address(puller), type(uint256).max)
      ),
      value: 0,
      allowFailure: false
    });
    calls[1] = _sweepCall(_currencies(address(tokenA)), recipient);

    vm.prank(depository);
    router.multicall(calls);

    // The allowance persists, but the sweep left it with nothing to draw on
    assertEq(
      tokenA.allowance(address(router), address(puller)),
      type(uint256).max
    );
    assertEq(tokenA.balanceOf(recipient), 500);
    assertEq(tokenA.balanceOf(address(router)), 0);

    // Insufficient balance, not insufficient allowance — the allowance is still live
    vm.expectRevert(
      abi.encodeWithSelector(
        IERC20Errors.ERC20InsufficientBalance.selector,
        address(router),
        0,
        1
      )
    );
    puller.pull(address(tokenA), address(router), 1);
  }

  function testSettlementHelpersRevertForExternalCallers() public {
    vm.prank(depository);
    vm.expectRevert(MulticallRouter.CallerNotSelf.selector);
    router.settle(address(0), recipient, 0);

    vm.prank(admin);
    vm.expectRevert(MulticallRouter.CallerNotSelf.selector);
    router.settle(address(tokenA), recipient, 0);
  }

  function testSettleNativeSweepsFullBalanceAfterMinimum() public {
    vm.deal(address(router), 1 ether);

    Call[] memory calls = _single(
      address(router),
      abi.encodeCall(
        MulticallRouter.settle,
        (address(0), recipient, 0.9 ether)
      ),
      0,
      false
    );

    vm.prank(depository);
    router.multicall(calls);

    assertEq(recipient.balance, 1 ether);
    assertEq(address(router).balance, 0);
  }

  function testRoleGrantRevertsAsInnerCall() public {
    // The router holds no role over itself, so a solver-supplied inner call cannot
    // enrol a depository of its own
    Call[] memory calls = _single(
      address(router),
      abi.encodeCall(
        IAccessControl.grantRole,
        (depositoryRole, makeAddr("evil"))
      ),
      0,
      false
    );

    vm.prank(depository);
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.CallFailed.selector,
        _unauthorized(address(router), adminRole)
      )
    );
    router.multicall(calls);
  }

  function testRenounceRevertsAsInnerCall() public {
    // Otherwise the depository could revoke its own role mid-bundle
    Call[] memory calls = _single(
      address(router),
      abi.encodeCall(IAccessControl.renounceRole, (depositoryRole, depository)),
      0,
      false
    );

    vm.prank(depository);
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.CallFailed.selector,
        abi.encodeWithSelector(MulticallRouter.RenounceNotAllowed.selector)
      )
    );
    router.multicall(calls);

    assertTrue(router.hasRole(depositoryRole, depository));
  }

  function testRenounceRevertsForADepositoryCallingDirectly() public {
    vm.prank(depository);
    vm.expectRevert(MulticallRouter.RenounceNotAllowed.selector);
    router.renounceRole(depositoryRole, depository);

    assertTrue(router.hasRole(depositoryRole, depository));
  }

  function testRenounceIsAllowedForOtherRoles() public {
    // `revokeRole` lets an admin remove itself anyway, so blocking this buys nothing
    vm.prank(admin);
    router.renounceRole(adminRole, admin);

    assertFalse(router.hasRole(adminRole, admin));
  }

  function testSettleNativeSettlesAtExactMinimum() public {
    vm.deal(address(router), 1 ether);

    vm.prank(address(router));
    router.settle(address(0), recipient, 1 ether);

    assertEq(recipient.balance, 1 ether);
  }

  function testSettleNativeRevertsBelowMinimum() public {
    vm.deal(address(router), 0.5 ether);

    vm.prank(address(router));
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.InsufficientSettlementBalance.selector,
        0.5 ether,
        1 ether
      )
    );
    router.settle(address(0), recipient, 1 ether);
  }

  function testSettleErc20SweepsFullBalanceAfterMinimum() public {
    tokenA.mintFor(1000, address(router));
    // Funded with native too, to pin that the ERC-20 branch leaves it alone
    vm.deal(address(router), 1 ether);

    Call[] memory calls = _single(
      address(router),
      abi.encodeCall(MulticallRouter.settle, (address(tokenA), recipient, 900)),
      0,
      false
    );

    vm.prank(depository);
    router.multicall(calls);

    assertEq(tokenA.balanceOf(recipient), 1000);
    assertEq(tokenA.balanceOf(address(router)), 0);
    assertEq(recipient.balance, 0);
    assertEq(address(router).balance, 1 ether);
  }

  function testSettleErc20RevertsBelowMinimum() public {
    tokenA.mintFor(500, address(router));

    vm.prank(address(router));
    vm.expectRevert(
      abi.encodeWithSelector(
        MulticallRouter.InsufficientSettlementBalance.selector,
        500,
        1000
      )
    );
    router.settle(address(tokenA), recipient, 1000);
  }

  function testRoutedCrossCurrencyFillWithResidualSweep() public {
    MockPool pool = new MockPool();
    tokenB.mintFor(90, address(pool));

    // Simulate the depository's withdrawal transfer of the withdrawal currency
    tokenA.mintFor(100, address(router));

    Call[] memory calls = new Call[](4);
    // Solver swap leg: pay 80 tokenA to the pool, receive 90 tokenB
    calls[0] = Call({
      to: address(tokenA),
      data: abi.encodeCall(IERC20.transfer, (address(pool), 80)),
      value: 0,
      allowFailure: false
    });
    calls[1] = Call({
      to: address(pool),
      data: abi.encodeCall(
        MockPool.give,
        (address(tokenB), address(router), 90)
      ),
      value: 0,
      allowFailure: false
    });
    // Oracle-generated fill settlement in the fill currency
    calls[2] = Call({
      to: address(router),
      data: abi.encodeCall(
        MulticallRouter.settle,
        (address(tokenB), recipient, 85)
      ),
      value: 0,
      allowFailure: false
    });
    // Mandatory bundled residual sweep
    calls[3] = _sweepCall(_currencies(address(tokenA), address(0)), recipient);

    vm.prank(depository);
    router.multicall(calls);

    assertEq(tokenB.balanceOf(recipient), 90);
    assertEq(tokenA.balanceOf(recipient), 20);
    assertEq(tokenA.balanceOf(address(router)), 0);
    assertEq(tokenB.balanceOf(address(router)), 0);
  }
}
