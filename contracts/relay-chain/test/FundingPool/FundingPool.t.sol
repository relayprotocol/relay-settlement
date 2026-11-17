// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ERC20View} from "../../contracts/ERC20View.sol";
import {RelayHub} from "../../contracts/RelayHub.sol";
import {FeeOnTransferToken} from "../../contracts/test-utils/FeeOnTransferToken.sol";
import {MyToken} from "../../contracts/test-utils/MyToken.sol";
import {
  DrawAuthorization,
  DrawLegKind,
  DrawRequest,
  PoolWithdrawal,
  DrawConfig,
  DrawConfigUpdate,
  DrawResolverUpdate,
  DrawRevocation
} from "../../contracts/funding-pools/IFundingPool.sol";
import {FundingPool} from "../../contracts/funding-pools/FundingPool.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {Eip712} from "../utils/Eip712.sol";

contract MockErc1271Wallet is IERC1271 {
  address internal immutable SIGNER;

  constructor(address signer) {
    SIGNER = signer;
  }

  function isValidSignature(
    bytes32 hash,
    bytes memory signature
  ) external view returns (bytes4 magicValue) {
    if (ECDSA.recover(hash, signature) == SIGNER) {
      return IERC1271.isValidSignature.selector;
    }
    return bytes4(0);
  }
}

/// @notice Test-only ERC-20 that re-enters a target on every transfer out,
///         replaying a stored role-based withdrawal. Used to prove the pool's
///         ReentrancyGuard closes the token-callback reentrancy vector.
contract ReentrantWithdrawToken is ERC20 {
  FundingPool internal pool;
  address internal recipient;
  bool internal armed;

  constructor() ERC20("ReentrantWithdrawToken", "REENT") {}

  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }

  function arm(FundingPool pool_, address recipient_) external {
    pool = pool_;
    recipient = recipient_;
    armed = true;
  }

  function _update(address from, address to, uint256 value) internal override {
    // Re-enter only on the pool's payout transfer, once, so the guard is what
    // stops the recursion rather than a disarmed flag
    if (armed && from == address(pool)) {
      armed = false;
      pool.withdraw(address(this), value, recipient);
    }
    super._update(from, to, value);
  }
}

contract FundingPoolTest is BaseTest {
  bytes32 internal constant POOL_WITHDRAWAL_TYPEHASH =
    keccak256(
      "PoolWithdrawal(address account,address token,uint256 amount,address recipient,uint256 nonce,uint256 deadline)"
    );

  bytes32 internal constant DRAW_CONFIG_UPDATE_TYPEHASH =
    keccak256(
      "DrawConfigUpdate(address account,address token,address authorizer,uint256 perOrderCap,uint256 budget,uint64 expiry,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

  bytes32 internal constant DRAW_AUTHORIZATION_TYPEHASH =
    keccak256(
      "DrawAuthorization(address account,address orderAddress,bytes32 planHash,uint256 nonce,uint256 deadline)"
    );

  /// @notice Plan hash the pool tests draw under. The pool takes it from the
  ///         trusted resolver's draw request and only checks that the
  ///         authorization signed the same value, so any constant works here
  bytes32 internal constant PLAN_HASH = keccak256("plan");

  /// @notice Budget sentinel that disables aggregate budget accounting
  uint256 internal constant UNLIMITED_BUDGET = type(uint256).max;

  /// @notice The pool's revocation jump bounds, mirrored as constants so the
  ///         helpers below stay free of external calls
  uint256 internal constant MIN_DRAW_NONCE_JUMP = 1 << 32;
  uint256 internal constant MAX_DRAW_NONCE_JUMP = type(uint64).max;
  bytes32 internal constant HUB_PERMIT_TYPEHASH =
    keccak256(
      "Permit(address owner,address spender,uint256 tokenId,uint256 value,uint256 nonce,uint256 deadline)"
    );

  bytes32 internal constant DRAW_RESOLVER_UPDATE_TYPEHASH =
    keccak256(
      "DrawResolverUpdate(address account,address resolver,bool allowed,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

  FundingPool internal pool;
  MyToken internal tokenIn;
  MyToken internal tokenOut;

  address internal secondAdmin;
  address internal withdrawer;
  address internal resolver;
  address internal funder;
  address internal poolAccount;
  uint256 internal poolAccountPk;
  /// @notice Operator key the pool account names as its draw authorizer
  address internal authorizer;
  uint256 internal authorizerPk;
  address internal recipient;
  address internal relayer;
  bytes32 internal poolDomain;
  /// @notice Storage slot of `drawNonces`, so helpers can read an
  ///         account's nonce with `vm.load` rather than an external call,
  ///         which would consume a pending `vm.prank` or `vm.expectRevert`
  uint256 internal drawNoncesSlot;
  uint256 internal configEpochSlot;

  function setUp() public override {
    super.setUp();
    secondAdmin = otherAccounts[0];
    withdrawer = otherAccounts[1];
    resolver = otherAccounts[2];
    funder = otherAccounts[3];
    (poolAccount, poolAccountPk) = makeAddrAndKey("poolAccount");
    (authorizer, authorizerPk) = makeAddrAndKey("authorizer");
    recipient = otherAccounts[4];
    relayer = otherAccounts[5];

    pool = new FundingPool(owner, withdrawer, resolver);
    tokenIn = new MyToken();
    tokenOut = new MyToken();
    tokenIn.mintFor(1_000, funder);

    poolDomain = Eip712.domainSeparator(
      "FundingPool",
      "1",
      block.chainid,
      address(pool)
    );
    drawNoncesSlot = _findDrawNoncesSlot();
    vm.record();
    pool.configEpoch(poolAccount);
    (bytes32[] memory reads, ) = vm.accesses(address(pool));
    for (uint256 slot; slot < 256; ++slot) {
      if (keccak256(abi.encode(poolAccount, slot)) == reads[0]) {
        configEpochSlot = slot;
        break;
      }
    }
  }

  function test_initializesIndependentRoleMembers() public view {
    assertTrue(pool.hasRole(pool.ADMIN_ROLE(), owner));
    assertTrue(pool.hasRole(pool.WITHDRAWER_ROLE(), withdrawer));
    assertTrue(pool.hasRole(pool.RESOLVER_ROLE(), resolver));

    assertFalse(pool.hasRole(pool.ADMIN_ROLE(), secondAdmin));
    assertEq(pool.getRoleAdmin(pool.ADMIN_ROLE()), pool.ADMIN_ROLE());
    assertEq(pool.getRoleAdmin(pool.RESOLVER_ROLE()), pool.ADMIN_ROLE());
  }

  // Deposits

  function test_depositForAttributesBalanceToAccount() public {
    vm.startPrank(funder);
    tokenIn.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit FundingPool.Deposited(poolAccount, address(tokenIn), funder, 100);
    pool.depositFor(poolAccount, address(tokenIn), 100);
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
    assertEq(tokenIn.balanceOf(address(pool)), 100);
    // The funder deposited for the pool account, so the funder holds no balance
    assertEq(pool.balances(funder, address(tokenIn)), 0);
  }

  function test_depositForIsPermissionless() public {
    // No role required: any funder can top up any account
    tokenIn.mintFor(50, relayer);
    vm.startPrank(relayer);
    tokenIn.approve(address(pool), 50);
    pool.depositFor(poolAccount, address(tokenIn), 50);
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 50);
  }

  function test_depositForScopesBalancesPerAccountAndToken() public {
    tokenOut.mintFor(300, funder);
    _deposit(poolAccount, 100);
    _deposit(withdrawer, 25);
    vm.startPrank(funder);
    tokenOut.approve(address(pool), 300);
    pool.depositFor(poolAccount, address(tokenOut), 300);
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
    assertEq(pool.balances(poolAccount, address(tokenOut)), 300);
    assertEq(pool.balances(withdrawer, address(tokenIn)), 25);
    assertEq(pool.balances(withdrawer, address(tokenOut)), 0);
  }

  function test_depositForRejectsZeroValues() public {
    vm.startPrank(funder);
    tokenIn.approve(address(pool), 100);

    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.depositFor(address(0), address(tokenIn), 100);

    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.depositFor(poolAccount, address(0), 100);

    vm.expectRevert(FundingPool.ZeroAmount.selector);
    pool.depositFor(poolAccount, address(tokenIn), 0);
    vm.stopPrank();
  }

  function test_depositForCreditsOnlyTheReceivedAmount() public {
    // 100 bps transfer fee: a 100-token deposit delivers 99 to the pool
    FeeOnTransferToken feeToken = new FeeOnTransferToken(100);
    feeToken.mint(funder, 100);

    vm.startPrank(funder);
    feeToken.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit FundingPool.Deposited(poolAccount, address(feeToken), funder, 99);
    pool.depositFor(poolAccount, address(feeToken), 100);
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(feeToken)), 99);
    assertEq(feeToken.balanceOf(address(pool)), 99);
  }

  // Credits

  function test_creditRequiresResolverRole() public {
    bytes32 resolverRole = pool.RESOLVER_ROLE();
    vm.startPrank(funder);
    tokenIn.approve(address(pool), 100);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        funder,
        resolverRole
      )
    );
    pool.credit(
      poolAccount,
      address(tokenIn),
      100,
      address(0),
      0,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();
  }

  function test_creditReturnsResolverTokensToAccountBalance() public {
    tokenIn.mintFor(40, resolver);
    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 40);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      address(0),
      poolAccount,
      address(tokenIn),
      keccak256("request"),
      resolver,
      DrawLegKind.SHORTFALL_TO_TARGET,
      0,
      40,
      0,
      0
    );
    pool.credit(
      poolAccount,
      address(tokenIn),
      40,
      address(0),
      0,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 40);
    assertEq(tokenIn.balanceOf(address(pool)), 40);
    assertEq(tokenIn.balanceOf(resolver), 0);
  }

  function test_creditRestoresBudgetAndPerOrderCapacity() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("restore");
    address o = _order(h);
    vm.startPrank(resolver);
    _debit(poolAccount, address(tokenIn), 100, h, 0, DrawLegKind.FIXED);
    tokenIn.approve(address(pool), 40);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      0,
      40,
      40,
      40
    );
    pool.credit(poolAccount, address(tokenIn), 40, o, 0, h, DrawLegKind.FIXED);
    _debit(poolAccount, address(tokenIn), 40, h, 1, DrawLegKind.FIXED);
    vm.stopPrank();
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 100);
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 0);
  }

  function test_creditRestorationIsClampedToOutstandingDraw() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("clamp");
    address o = _order(h);
    vm.startPrank(resolver);
    _debit(poolAccount, address(tokenIn), 60, h, 0, DrawLegKind.FIXED);
    tokenIn.mintFor(40, resolver);
    tokenIn.approve(address(pool), 100);
    pool.credit(poolAccount, address(tokenIn), 100, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 100);
  }

  function test_creditDoesNotRestoreBudgetAcrossConfigVersions() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, type(uint256).max, 0);
    bytes32 h = keccak256("old-config");
    address o = _order(h);

    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 100, h, 0, DrawLegKind.FIXED);
    _configurePoolAccount(100, 50, 0);

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      0,
      100,
      100,
      0
    );
    pool.credit(poolAccount, address(tokenIn), 100, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();

    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 50);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
  }

  function test_refundOfOlderVersionDrawCannotRestoreCurrentBudget() public {
    // An old-config draw of 40, a tighter new config with budget 30 and a
    // 30 draw under it. Refunding the old 40 must not hand the new config
    // its 30 back, or the new budget funds 60
    _deposit(poolAccount, 200);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("mixed-versions");
    address o = _order(h);
    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 40, h, 0, DrawLegKind.FIXED);

    _configurePoolAccount(100, 30, 0);
    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 30, h, 1, DrawLegKind.FIXED);

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 40);
    pool.credit(poolAccount, address(tokenIn), 40, o, 0, h, DrawLegKind.FIXED);
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 0);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 30);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.BudgetExceeded.selector,
        poolAccount,
        address(tokenIn),
        30,
        0
      )
    );
    _debit(poolAccount, address(tokenIn), 30, h, 2, DrawLegKind.FIXED);
    vm.stopPrank();
  }

  function test_refundRestoresOnlyItsOwnLegsBudgetVersion() public {
    _deposit(poolAccount, 200);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("mixed-refunds");
    address o = _order(h);
    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 40, h, 0, DrawLegKind.FIXED);
    _configurePoolAccount(100, 30, 0);
    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 30, h, 1, DrawLegKind.FIXED);

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 80);
    // The current-version leg restores its own draw and budget; the 20 above
    // its draw is a plain balance credit
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      1,
      50,
      30,
      30
    );
    pool.credit(poolAccount, address(tokenIn), 50, o, 1, h, DrawLegKind.FIXED);
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 30);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 40);

    // The old-version leg only lowers the order's net draw
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      0,
      20,
      20,
      0
    );
    pool.credit(poolAccount, address(tokenIn), 20, o, 0, h, DrawLegKind.FIXED);
    (, budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 30);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 20);

    // A leg already made whole cannot restore twice
    tokenIn.mintFor(10, resolver);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      1,
      10,
      0,
      0
    );
    pool.credit(poolAccount, address(tokenIn), 10, o, 1, h, DrawLegKind.FIXED);
    vm.stopPrank();
    (, budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 30);
  }

  function test_creditAboveOneLegsDrawCannotConsumeAnotherLegsHeadroom()
    public
  {
    // Leg 0 drew 90 and leg 1 drew 10. A 100 credit naming leg 1 returns
    // leg 1's 10 and keeps the other 90 as a plain balance credit: leg 0's
    // outstanding draw, and its budget, stay restorable
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("headroom");
    address o = _order(h);
    vm.startPrank(resolver);
    _debit(poolAccount, address(tokenIn), 90, h, 0, DrawLegKind.FIXED);
    _debit(poolAccount, address(tokenIn), 10, h, 1, DrawLegKind.FIXED);

    tokenIn.approve(address(pool), 190);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      1,
      100,
      10,
      10
    );
    pool.credit(poolAccount, address(tokenIn), 100, o, 1, h, DrawLegKind.FIXED);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 90);
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 10);

    tokenIn.mintFor(90, resolver);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      o,
      poolAccount,
      address(tokenIn),
      h,
      resolver,
      DrawLegKind.FIXED,
      0,
      90,
      90,
      90
    );
    pool.credit(poolAccount, address(tokenIn), 90, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
    (, budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 100);
    assertEq(pool.balances(poolAccount, address(tokenIn)), 190);
  }

  function test_creditDoesNotExceedBudgetFromSignedConfigUpdate() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("signed-config-budget");
    address o = _order(h);

    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 100, h, 0, DrawLegKind.FIXED);

    DrawConfigUpdate memory update = _configUpdate(
      100,
      pool.drawNonces(poolAccount) + 1
    );
    update.budget = 20;
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 100);
    pool.credit(poolAccount, address(tokenIn), 100, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();

    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 20);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
  }

  function test_creditRestoresBudgetAfterAuthorizationRevocation() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("revoked-authorization");
    address o = _order(h);

    vm.prank(resolver);
    _debit(poolAccount, address(tokenIn), 60, h, 0, DrawLegKind.FIXED);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(_revocationNonce(poolAccount));

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 60);
    pool.credit(poolAccount, address(tokenIn), 60, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();

    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 100);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
  }

  function test_creditRestoresOnlyFiniteDrawsFromCurrentConfig() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(100, 100, 0);
    bytes32 h = keccak256("finite");
    address o = _order(h);

    vm.startPrank(resolver);
    _debit(poolAccount, address(tokenIn), 60, h, 0, DrawLegKind.FIXED);
    tokenIn.approve(address(pool), 60);
    pool.credit(poolAccount, address(tokenIn), 60, o, 0, h, DrawLegKind.FIXED);
    vm.stopPrank();

    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 100);
    assertEq(pool.orderDraws(o, poolAccount, address(tokenIn)), 0);
  }

  // Role-based withdrawals

  function test_roleWithdrawRequiresWithdrawerRole() public {
    _deposit(withdrawer, 200);
    bytes32 withdrawerRole = pool.WITHDRAWER_ROLE();

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        owner,
        withdrawerRole
      )
    );
    vm.prank(owner);
    pool.withdraw(address(tokenIn), 50, owner);

    vm.prank(withdrawer);
    pool.withdraw(address(tokenIn), 50, owner);

    assertEq(pool.balances(withdrawer, address(tokenIn)), 150);
    assertEq(tokenIn.balanceOf(address(pool)), 150);
    assertEq(tokenIn.balanceOf(owner), 50);
  }

  function test_roleWithdrawCannotSpendOtherAccountBalances() public {
    // The pool is rich, but none of it belongs to the withdrawer's account
    _deposit(poolAccount, 200);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InsufficientBalance.selector,
        withdrawer,
        address(tokenIn),
        50,
        0
      )
    );
    vm.prank(withdrawer);
    pool.withdraw(address(tokenIn), 50, withdrawer);
  }

  // Account-signed withdrawals

  function test_accountSignedWithdrawPaysRecipient() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 1);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);

    // Any relayer may submit the account-signed message and pay its gas
    vm.expectEmit(address(pool));
    emit FundingPool.Withdrawn(poolAccount, recipient, address(tokenIn), 80);
    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);

    assertEq(pool.balances(poolAccount, address(tokenIn)), 120);
    assertEq(tokenIn.balanceOf(recipient), 80);
    assertTrue(pool.usedWithdrawalNonces(poolAccount, 1));
  }

  function test_accountSignedWithdrawSupportsErc1271Accounts() public {
    (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey(
      "walletSigner"
    );
    MockErc1271Wallet wallet = new MockErc1271Wallet(walletSigner);
    _deposit(address(wallet), 200);

    PoolWithdrawal memory withdrawal = _withdrawal(80, 1);
    withdrawal.account = address(wallet);
    bytes memory signature = _signWithdrawal(withdrawal, walletSignerPk);

    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);

    assertEq(pool.balances(address(wallet), address(tokenIn)), 120);
    assertEq(tokenIn.balanceOf(recipient), 80);
  }

  function test_rejectsWithdrawalReplay() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 2);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);

    vm.startPrank(relayer);
    pool.withdraw(withdrawal, signature);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.WithdrawalNonceUsed.selector,
        poolAccount,
        2
      )
    );
    pool.withdraw(withdrawal, signature);
    vm.stopPrank();
  }

  function test_cancelledWithdrawalNonceBlocksSignedWithdrawal() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 7);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);
    vm.prank(owner);
    pool.pause();

    vm.expectEmit(address(pool));
    emit FundingPool.WithdrawalNonceCancelled(poolAccount, 7);
    vm.prank(poolAccount);
    pool.cancelWithdrawalNonce(7);
    assertTrue(pool.usedWithdrawalNonces(poolAccount, 7));

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.WithdrawalNonceUsed.selector,
        poolAccount,
        7
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);
    assertEq(pool.balances(poolAccount, address(tokenIn)), 200);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.WithdrawalNonceUsed.selector,
        poolAccount,
        7
      )
    );
    vm.prank(poolAccount);
    pool.cancelWithdrawalNonce(7);
  }

  function test_cancelWithdrawalNonceIsAccountScoped() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 7);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);

    vm.prank(relayer);
    pool.cancelWithdrawalNonce(7);
    assertTrue(pool.usedWithdrawalNonces(relayer, 7));
    assertFalse(pool.usedWithdrawalNonces(poolAccount, 7));

    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);
    assertEq(pool.balances(poolAccount, address(tokenIn)), 120);
  }

  function test_rejectsExpiredWithdrawal() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 3);
    withdrawal.deadline = block.timestamp - 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.WithdrawalExpired.selector,
        withdrawal.deadline
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, poolAccountPk));
  }

  function test_rejectsTamperedWithdrawal() public {
    _deposit(poolAccount, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 4);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);

    // Raise the amount after signing; the digest no longer matches
    withdrawal.amount = 200;

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidWithdrawal.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);
  }

  function test_rejectsWithdrawalSignedByAnotherAccount() public {
    _deposit(poolAccount, 200);
    (, uint256 strayPk) = makeAddrAndKey("stray");
    PoolWithdrawal memory withdrawal = _withdrawal(80, 5);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidWithdrawal.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, strayPk));
  }

  function test_rejectsWithdrawalExceedingAccountBalance() public {
    // The pool holds plenty overall, but the pool account holds only 50
    _deposit(poolAccount, 50);
    _deposit(withdrawer, 500);
    PoolWithdrawal memory withdrawal = _withdrawal(100, 6);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InsufficientBalance.selector,
        poolAccount,
        address(tokenIn),
        100,
        50
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, poolAccountPk));
  }

  function test_rejectsCrossPoolWithdrawalReplay() public {
    // A second pool with identical role members but a distinct EIP-712 domain
    FundingPool otherPool = new FundingPool(owner, withdrawer, resolver);
    tokenIn.mintFor(200, funder);
    vm.startPrank(funder);
    tokenIn.approve(address(otherPool), 200);
    otherPool.depositFor(poolAccount, address(tokenIn), 200);
    vm.stopPrank();

    // Signature is bound to `pool`'s domain via `_signWithdrawal`
    PoolWithdrawal memory withdrawal = _withdrawal(80, 7);
    bytes memory signature = _signWithdrawal(withdrawal, poolAccountPk);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidWithdrawal.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    otherPool.withdraw(withdrawal, signature);
  }

  // Hub ERC-20 views

  function test_supportsHubErc20ViewAssets() public {
    RelayHub hub = new RelayHub(owner);
    uint256 tokenId = 42;
    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.mint(funder, tokenId, 500);
    vm.stopPrank();
    address viewToken = hub.erc20Views(tokenId);

    // Deposit and withdraw through the exact same ERC-20 code path
    vm.startPrank(funder);
    ERC20View(viewToken).approve(address(pool), 500);
    pool.depositFor(poolAccount, viewToken, 500);
    vm.stopPrank();
    assertEq(pool.balances(poolAccount, viewToken), 500);

    PoolWithdrawal memory withdrawal = _withdrawal(200, 1);
    withdrawal.token = viewToken;
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, poolAccountPk));

    assertEq(pool.balances(poolAccount, viewToken), 300);
    assertEq(hub.balanceOf(recipient, tokenId), 200);
    assertEq(hub.balanceOf(address(pool), tokenId), 300);
  }

  // Account-signed deposits of Hub ERC-20 views

  function test_depositFromWithPermitPullsFromTheAccountAndCreditsIt() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    (uint8 v, bytes32 r, bytes32 s) = _signHubPermit(
      hub,
      poolAccountPk,
      poolAccount,
      tokenId,
      500,
      block.timestamp + 1 hours
    );

    vm.expectEmit(address(pool));
    emit FundingPool.Deposited(poolAccount, viewToken, poolAccount, 500);
    vm.prank(relayer);
    pool.depositFromWithPermit(
      poolAccount,
      viewToken,
      500,
      block.timestamp + 1 hours,
      v,
      r,
      s
    );

    assertEq(pool.balances(poolAccount, viewToken), 500);
    assertEq(hub.balanceOf(poolAccount, tokenId), 0);
    assertEq(hub.balanceOf(address(pool), tokenId), 500);
    assertEq(hub.nonces(poolAccount), 1);
    assertEq(ERC20View(viewToken).allowance(poolAccount, address(pool)), 0);
  }

  function test_depositFromWithPermitRejectsAPermitAlreadyConsumed() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _signHubPermit(
      hub,
      poolAccountPk,
      poolAccount,
      tokenId,
      500,
      deadline
    );
    // Front-run straight to the Hub, or a relay retried after it landed: the
    // allowance is there, but the signature no longer authorizes anything
    hub.permit(poolAccount, address(pool), tokenId, 500, deadline, v, r, s);

    vm.expectRevert(RelayHub.InvalidPermitSignature.selector);
    vm.prank(relayer);
    pool.depositFromWithPermit(poolAccount, viewToken, 500, deadline, v, r, s);
    assertEq(pool.balances(poolAccount, viewToken), 0);
    assertEq(hub.balanceOf(poolAccount, tokenId), 500);
  }

  function test_depositFromWithPermitNeverSpendsAStandingAllowance() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    // An approval granted for the ordinary depositFor path
    vm.prank(poolAccount);
    ERC20View(viewToken).approve(address(pool), type(uint256).max);

    vm.expectRevert();
    vm.prank(relayer);
    pool.depositFromWithPermit(
      poolAccount,
      viewToken,
      500,
      0,
      0,
      bytes32(0),
      bytes32(0)
    );
    assertEq(pool.balances(poolAccount, viewToken), 0);
    assertEq(hub.balanceOf(poolAccount, tokenId), 500);
  }

  function test_depositFromWithPermitRejectsAnInvalidPermit() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    uint256 deadline = block.timestamp + 1 hours;
    (, uint256 strayPk) = makeAddrAndKey("stray");
    (uint8 v, bytes32 r, bytes32 s) = _signHubPermit(
      hub,
      strayPk,
      poolAccount,
      tokenId,
      500,
      deadline
    );

    vm.expectRevert(RelayHub.InvalidPermitSignature.selector);
    vm.prank(relayer);
    pool.depositFromWithPermit(poolAccount, viewToken, 500, deadline, v, r, s);
    assertEq(hub.nonces(poolAccount), 0);
  }

  function test_depositFromWithPermitRejectsZeroValuesAndPlainTokens() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _signHubPermit(
      hub,
      poolAccountPk,
      poolAccount,
      tokenId,
      500,
      deadline
    );

    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.depositFromWithPermit(address(0), viewToken, 500, deadline, v, r, s);
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.depositFromWithPermit(poolAccount, address(0), 500, deadline, v, r, s);
    vm.expectRevert(FundingPool.ZeroAmount.selector);
    pool.depositFromWithPermit(poolAccount, viewToken, 0, deadline, v, r, s);

    // A plain ERC-20 names no Hub, so it cannot be deposited this way
    vm.expectRevert();
    pool.depositFromWithPermit(
      poolAccount,
      address(tokenIn),
      500,
      deadline,
      v,
      r,
      s
    );
  }

  function test_depositFromWithPermitIsBlockedWhilePaused() public {
    (RelayHub hub, address viewToken, uint256 tokenId) = _hubView(500);
    uint256 deadline = block.timestamp + 1 hours;
    (uint8 v, bytes32 r, bytes32 s) = _signHubPermit(
      hub,
      poolAccountPk,
      poolAccount,
      tokenId,
      500,
      deadline
    );
    vm.prank(owner);
    pool.pause();

    vm.expectRevert(Pausable.EnforcedPause.selector);
    pool.depositFromWithPermit(poolAccount, viewToken, 500, deadline, v, r, s);
  }

  // Draw configs

  function test_setDrawConfigStoresAndEmits() public {
    vm.expectEmit(address(pool));
    emit FundingPool.DrawConfigSet(
      poolAccount,
      address(tokenIn),
      authorizer,
      50,
      200,
      uint64(block.timestamp + 30 days)
    );
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: 200,
        authorizer: authorizer,
        expiry: uint64(block.timestamp + 30 days)
      })
    );

    (
      uint256 perOrderCap,
      uint256 budget,
      address configAuthorizer,
      uint64 expiry
    ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(configAuthorizer, authorizer);
    assertEq(perOrderCap, 50);
    assertEq(budget, 200);
    assertEq(expiry, uint64(block.timestamp + 30 days));
  }

  function test_setDrawResolverStoresAndEmits() public {
    assertFalse(pool.drawResolvers(poolAccount, resolver));

    vm.expectEmit(address(pool));
    emit FundingPool.DrawResolverSet(poolAccount, resolver, true);
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, true);
    assertTrue(pool.drawResolvers(poolAccount, resolver));

    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, false);
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function test_drawSettersRejectZeroAddresses() public {
    vm.startPrank(poolAccount);
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.setDrawConfig(
      address(0),
      DrawConfig({perOrderCap: 1, budget: 1, authorizer: authorizer, expiry: 0})
    );
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    pool.setDrawResolver(address(0), true);
    vm.stopPrank();
  }

  // Account-signed draw config updates

  function test_accountSignedConfigUpdateStoresAndEmits() public {
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);

    // Any relayer may submit the account-signed message and pay its gas
    vm.expectEmit(address(pool));
    emit FundingPool.DrawConfigSet(
      poolAccount,
      address(tokenIn),
      authorizer,
      50,
      200,
      0
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, signature);

    (
      uint256 perOrderCap,
      uint256 budget,
      address configAuthorizer,
      uint64 expiry
    ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(configAuthorizer, authorizer);
    assertEq(perOrderCap, 50);
    assertEq(budget, 200);
    assertEq(expiry, 0);
    assertEq(pool.drawNonces(poolAccount), 1);
  }

  function test_accountSignedResolverUpdateStoresAndEmits() public {
    DrawResolverUpdate memory update = _resolverUpdate(true, 1);
    bytes memory signature = _signResolverUpdate(update, poolAccountPk);

    vm.expectEmit(address(pool));
    emit FundingPool.DrawResolverSet(poolAccount, resolver, true);
    vm.prank(relayer);
    pool.setDrawResolver(update, signature);

    assertTrue(pool.drawResolvers(poolAccount, resolver));
    assertEq(pool.drawNonces(poolAccount), 1);

    // A follow-up signed message revokes the resolver again
    DrawResolverUpdate memory revocation = _resolverUpdate(false, 2);
    vm.prank(relayer);
    pool.setDrawResolver(
      revocation,
      _signResolverUpdate(revocation, poolAccountPk)
    );
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function test_accountSignedUpdatesSupportErc1271Accounts() public {
    (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey(
      "walletSigner"
    );
    MockErc1271Wallet wallet = new MockErc1271Wallet(walletSigner);

    DrawConfigUpdate memory update = _configUpdate(50, 1);
    update.account = address(wallet);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, walletSignerPk));

    (uint256 perOrderCap, , , ) = pool.drawConfig(
      address(wallet),
      address(tokenIn)
    );
    assertEq(perOrderCap, 50);

    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 2);
    allowlist.account = address(wallet);
    vm.prank(relayer);
    pool.setDrawResolver(
      allowlist,
      _signResolverUpdate(allowlist, walletSignerPk)
    );
    assertTrue(pool.drawResolvers(address(wallet), resolver));
  }

  function test_rejectsDrawConfigUpdateReplay() public {
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);

    vm.startPrank(relayer);
    pool.setDrawConfig(update, signature);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawNonceMismatch.selector,
        poolAccount,
        2,
        1
      )
    );
    pool.setDrawConfig(update, signature);
    vm.stopPrank();
  }

  function test_drawNoncesAreSharedAcrossUpdateKinds() public {
    // Config and resolver updates consume one nonce space, so a stale message
    // of either kind cannot ride alongside a newer one reusing its nonce
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawNonceMismatch.selector,
        poolAccount,
        2,
        1
      )
    );
    vm.prank(relayer);
    pool.setDrawResolver(
      allowlist,
      _signResolverUpdate(allowlist, poolAccountPk)
    );
  }

  function test_rejectsSupersededDrawConfigUpdate() public {
    // Signed first, but another update takes its nonce before it is submitted
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 1);
    bytes memory signature = _signResolverUpdate(allowlist, poolAccountPk);

    DrawConfigUpdate memory update = _configUpdate(50, 1);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));
    assertEq(pool.drawNonces(poolAccount), 1);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawNonceMismatch.selector,
        poolAccount,
        2,
        1
      )
    );
    vm.prank(relayer);
    pool.setDrawResolver(allowlist, signature);
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function testFuzz_directChangesInvalidateQueuedUpdates(
    uint8 change,
    uint8 gap
  ) public {
    change = uint8(bound(change, 0, 2));
    gap = uint8(bound(gap, 2, 12));
    DrawConfigUpdate memory config = _configUpdate(50, gap);
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, gap);
    bytes memory configSignature = _signConfigUpdate(config, poolAccountPk);
    bytes memory resolverSignature = _signResolverUpdate(
      allowlist,
      poolAccountPk
    );
    vm.startPrank(poolAccount);
    if (change == 0) {
      pool.setDrawConfig(address(tokenIn), DrawConfig(0, 0, address(0), 0));
    } else if (change == 1) {
      pool.setDrawResolver(resolver, false);
    } else {
      pool.revokeDrawAuthorizations(_revocationNonce(poolAccount));
    }
    vm.stopPrank();
    // Advance within the new epoch until the old queued nonce is next. A
    // revocation leaps past it instead, so the epoch is what refuses it
    for (uint256 nonce = 2; change != 2 && nonce < gap; ++nonce) {
      DrawResolverUpdate memory fresh = _resolverUpdate(false, nonce);
      pool.setDrawResolver(fresh, _signResolverUpdate(fresh, poolAccountPk));
    }
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.setDrawConfig(config, configSignature);
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.setDrawResolver(allowlist, resolverSignature);
    assertEq(pool.configEpoch(poolAccount), 1);
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function test_queuedSignaturesCannotBeRebasedToTheNewEpoch() public {
    DrawConfigUpdate memory config = _configUpdate(50, 2);
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 2);
    bytes memory configSignature = _signConfigUpdate(config, poolAccountPk);
    bytes memory resolverSignature = _signResolverUpdate(
      allowlist,
      poolAccountPk
    );
    uint256 revoked = _revocationNonce(poolAccount);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(revoked);
    // Rebasing both counters onto the new epoch still leaves the signature
    // over the old ones, so it is the signature check that refuses them
    config.epoch = 1;
    config.nonce = revoked + 1;
    allowlist.epoch = 1;
    allowlist.nonce = revoked + 1;
    vm.expectPartialRevert(FundingPool.InvalidDrawConfigUpdate.selector);
    pool.setDrawConfig(config, configSignature);
    vm.expectPartialRevert(FundingPool.InvalidDrawConfigUpdate.selector);
    pool.setDrawResolver(allowlist, resolverSignature);
    assertEq(pool.drawNonces(poolAccount), revoked);
  }

  function testFuzz_signedRevocationSurvivesQueuedGrants(
    uint8 count,
    bool contractWallet
  ) public {
    count = uint8(bound(count, 1, 8));
    address account = contractWallet
      ? address(new MockErc1271Wallet(poolAccount))
      : poolAccount;
    DrawRevocation memory revocation = _revocation(account);
    bytes memory signature = _signRevocation(revocation, poolAccountPk);
    for (uint256 nonce = 1; nonce <= count; ++nonce) {
      DrawResolverUpdate memory grant = _resolverUpdate(true, nonce);
      grant.account = account;
      pool.setDrawResolver(grant, _signResolverUpdate(grant, poolAccountPk));
    }
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(revocation, signature);
    assertEq(pool.configEpoch(account), 1);
    assertEq(pool.drawNonces(account), revocation.nonce);
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.revokeDrawAuthorizations(revocation, signature);
  }

  function test_presignedBatchUsesOneEpoch() public {
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 1);
    DrawConfigUpdate memory config = _configUpdate(50, 2);
    bytes memory resolverSignature = _signResolverUpdate(
      allowlist,
      poolAccountPk
    );
    bytes memory configSignature = _signConfigUpdate(config, poolAccountPk);
    pool.setDrawResolver(allowlist, resolverSignature);
    pool.setDrawConfig(config, configSignature);
    assertEq(pool.configEpoch(poolAccount), 0);
    assertEq(pool.drawNonces(poolAccount), 2);
    assertTrue(pool.drawResolvers(poolAccount, resolver));
  }

  function test_signedRevocationCancelsQueuedUpdatesAndDrawsWhilePaused()
    public
  {
    _configurePoolAccount(50, 200, 0);
    uint256 epoch = pool.configEpoch(poolAccount);
    uint256 nonce = pool.drawNonces(poolAccount);
    DrawConfigUpdate memory config = _configUpdate(50, nonce + 2);
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, nonce + 2);
    bytes memory configSignature = _signConfigUpdate(config, poolAccountPk);
    bytes memory resolverSignature = _signResolverUpdate(
      allowlist,
      poolAccountPk
    );
    DrawRevocation memory revocation = _revocation(poolAccount);
    bytes memory signature = _signRevocation(revocation, poolAccountPk);
    vm.prank(owner);
    pool.pause();
    vm.expectEmit(address(pool));
    emit FundingPool.DrawConfigEpochAdvanced(poolAccount, epoch + 1);
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(revocation, signature);
    assertEq(pool.configEpoch(poolAccount), epoch + 1);
    assertEq(pool.drawNonces(poolAccount), revocation.nonce);
    assertEq(pool.configEpoch(relayer), 0);
    assertEq(pool.drawNonces(relayer), 0);
    assertTrue(pool.drawResolvers(poolAccount, resolver));
    (, , address storedAuthorizer, ) = pool.drawConfig(
      poolAccount,
      address(tokenIn)
    );
    assertEq(storedAuthorizer, authorizer);
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.setDrawConfig(config, configSignature);
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.setDrawResolver(allowlist, resolverSignature);
    vm.expectPartialRevert(FundingPool.DrawConfigEpochMismatch.selector);
    pool.revokeDrawAuthorizations(revocation, signature);
    DrawConfigUpdate memory fresh = _configUpdate(50, revocation.nonce + 1);
    pool.setDrawConfig(fresh, _signConfigUpdate(fresh, poolAccountPk));
    assertEq(pool.configEpoch(poolAccount), epoch + 1);
  }

  function test_signedRevocationSupportsErc1271() public {
    MockErc1271Wallet wallet = new MockErc1271Wallet(poolAccount);
    DrawRevocation memory revocation = _revocation(address(wallet));
    bytes memory signature = _signRevocation(revocation, poolAccountPk);
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(revocation, signature);
    assertEq(pool.configEpoch(address(wallet)), 1);
    assertEq(pool.drawNonces(address(wallet)), revocation.nonce);
    DrawConfigUpdate memory config = _configUpdate(50, revocation.nonce + 1);
    config.account = address(wallet);
    config.epoch = 1;
    pool.setDrawConfig(config, _signConfigUpdate(config, poolAccountPk));
    assertEq(pool.drawNonces(address(wallet)), revocation.nonce + 1);
  }

  function testFuzz_signedRevocationRejectsInvalidMessage(
    uint8 mutation
  ) public {
    mutation = uint8(bound(mutation, 0, 7));
    DrawRevocation memory revocation = _revocation(poolAccount);
    bytes memory signature = _signRevocation(revocation, poolAccountPk);
    bytes4 expected;
    if (mutation == 0) {
      revocation.account = address(0);
      expected = FundingPool.ZeroAddress.selector;
    } else if (mutation == 1) {
      revocation.epoch += 1;
      expected = FundingPool.DrawConfigEpochMismatch.selector;
    } else if (mutation == 2) {
      revocation.account = relayer;
      expected = FundingPool.InvalidDrawConfigUpdate.selector;
    } else if (mutation == 3) {
      vm.warp(revocation.deadline + 1);
      expected = FundingPool.DrawConfigUpdateExpired.selector;
    } else if (mutation == 4) {
      signature = _signRevocation(revocation, authorizerPk);
      expected = FundingPool.InvalidDrawConfigUpdate.selector;
    } else if (mutation == 5) {
      revocation.deadline += 1;
      expected = FundingPool.InvalidDrawConfigUpdate.selector;
    } else if (mutation == 6) {
      revocation.nonce += 1;
      expected = FundingPool.InvalidDrawConfigUpdate.selector;
    } else {
      revocation.nonce = 0;
      signature = _signRevocation(revocation, poolAccountPk);
      expected = FundingPool.InvalidRevocationNonce.selector;
    }
    vm.expectPartialRevert(expected);
    pool.revokeDrawAuthorizations(revocation, signature);
    assertEq(pool.configEpoch(poolAccount), 0);
    assertEq(pool.drawNonces(poolAccount), 0);
  }

  function test_signedRevocationRejectsCrossPoolReplay() public {
    FundingPool otherPool = new FundingPool(owner, withdrawer, resolver);
    DrawRevocation memory revocation = _revocation(poolAccount);
    bytes memory signature = _signRevocation(revocation, poolAccountPk);
    vm.expectPartialRevert(FundingPool.InvalidDrawConfigUpdate.selector);
    otherPool.revokeDrawAuthorizations(revocation, signature);
    assertEq(otherPool.configEpoch(poolAccount), 0);
    assertEq(otherPool.drawNonces(poolAccount), 0);
  }

  function _revocation(
    address account
  ) internal view returns (DrawRevocation memory) {
    return
      DrawRevocation(
        account,
        _configEpoch(account),
        _revocationNonce(account),
        block.timestamp + 1 hours
      );
  }

  /// @notice The nonce a revocation of the account should move to: a
  ///         pseudo-random jump within the pool's bounds, as the SDK's
  ///         `getRandomFundingPoolRevocationNonce` gives relayers. Never
  ///         `+1` or any other fixed step: that is what an authorizer can
  ///         have pre-signed for, so it would kill nothing
  function _revocationNonce(address account) internal view returns (uint256) {
    uint256 current = _drawNonce(account);
    // Like the SDK, start at twice the pool's minimum so queued advances
    // cannot push a signed target under it
    uint256 floor = 2 * MIN_DRAW_NONCE_JUMP;
    uint256 jump = floor +
      (uint256(keccak256(abi.encode("revocation", account, current))) %
        (MAX_DRAW_NONCE_JUMP - floor + 1));
    return current + jump;
  }

  function _signRevocation(
    DrawRevocation memory revocation,
    uint256 signerPk
  ) internal view returns (bytes memory) {
    bytes32 structHash = keccak256(
      abi.encode(
        keccak256(
          "DrawRevocation(address account,uint256 epoch,uint256 nonce,uint256 deadline)"
        ),
        revocation.account,
        revocation.epoch,
        revocation.nonce,
        revocation.deadline
      )
    );
    return Eip712.sign(signerPk, poolDomain, structHash);
  }

  function test_queuedGrantCannotUndoDirectRevocation() public {
    _configurePoolAccount(50, 200, 0);
    DrawConfigUpdate memory update = _configUpdate(
      50,
      pool.drawNonces(poolAccount) + 2
    );
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: 200,
        authorizer: address(0),
        expiry: 0
      })
    );
    vm.expectPartialRevert(
      bytes4(keccak256("DrawConfigEpochMismatch(address,uint256,uint256)"))
    );
    pool.setDrawConfig(update, signature);
  }

  function test_directRevocationInvalidatesOutstandingSignedUpdate() public {
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, true);
    uint256 nonce = pool.drawNonces(poolAccount) + 1;
    DrawResolverUpdate memory allowlist = _resolverUpdate(true, nonce);
    bytes memory signature = _signResolverUpdate(allowlist, poolAccountPk);

    // Revoking directly bumps past the outstanding signed grant
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, false);
    assertEq(pool.drawNonces(poolAccount), nonce);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawConfigEpochMismatch.selector,
        poolAccount,
        pool.configEpoch(poolAccount),
        allowlist.epoch
      )
    );
    vm.prank(relayer);
    pool.setDrawResolver(allowlist, signature);
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function testFuzz_rejectsAnyDrawNonceButTheNext(uint256 nonce) public {
    // The signer never picks the value: only last applied plus one is
    // accepted, so no update a relayer composes can park the counter at a
    // place the account cannot move past (the near-maximum values included)
    vm.assume(nonce != 1);
    DrawConfigUpdate memory update = _configUpdate(50, nonce);
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawNonceMismatch.selector,
        poolAccount,
        1,
        nonce
      )
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, signature);
    assertEq(pool.drawNonces(poolAccount), 0);
  }

  function test_nearMaximumDrawNonceCannotFreezeTheAccount() public {
    // The council's case: max - 1 would once have been accepted and left no
    // reachable next value. Now it is refused and the account keeps moving
    DrawConfigUpdate memory update = _configUpdate(50, type(uint256).max - 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawNonceMismatch.selector,
        poolAccount,
        1,
        type(uint256).max - 1
      )
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    uint256 revoked = _revocationNonce(poolAccount);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(revoked);
    DrawConfigUpdate memory next = _configUpdate(50, revoked + 1);
    vm.prank(relayer);
    pool.setDrawConfig(next, _signConfigUpdate(next, poolAccountPk));
    assertEq(pool.drawNonces(poolAccount), revoked + 1);
  }

  function test_rejectsExpiredDrawConfigUpdate() public {
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    update.deadline = block.timestamp - 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawConfigUpdateExpired.selector,
        update.deadline
      )
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));
  }

  function test_rejectsTamperedDrawConfigUpdate() public {
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);

    // Raise the cap after signing; the digest no longer matches
    update.perOrderCap = 500;

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawConfigUpdate.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, signature);
  }

  function test_rejectsDrawConfigUpdateSignedByAnotherAccount() public {
    (, uint256 strayPk) = makeAddrAndKey("stray");

    DrawConfigUpdate memory update = _configUpdate(50, 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawConfigUpdate.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, strayPk));

    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawConfigUpdate.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    pool.setDrawResolver(allowlist, _signResolverUpdate(allowlist, strayPk));
  }

  function test_rejectsCrossPoolDrawConfigUpdateReplay() public {
    // A second pool with identical role members but a distinct EIP-712 domain
    FundingPool otherPool = new FundingPool(owner, withdrawer, resolver);

    // Signature is bound to `pool`'s domain via `_signConfigUpdate`
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    bytes memory signature = _signConfigUpdate(update, poolAccountPk);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawConfigUpdate.selector,
        poolAccount
      )
    );
    vm.prank(relayer);
    otherPool.setDrawConfig(update, signature);
  }

  function test_signedDrawConfigUpdatesRejectZeroAddresses() public {
    DrawConfigUpdate memory update = _configUpdate(50, 1);
    update.token = address(0);
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 1);
    allowlist.resolver = address(0);
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    vm.prank(relayer);
    pool.setDrawResolver(
      allowlist,
      _signResolverUpdate(allowlist, poolAccountPk)
    );
  }

  function test_signedDrawConfigUpdatesWorkWhilePaused() public {
    // Guardrail management stays open while paused so an account can always
    // tighten or revoke via the relayed path too
    vm.prank(owner);
    pool.pause();

    DrawConfigUpdate memory update = _configUpdate(0, 1);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    (uint256 perOrderCap, , , ) = pool.drawConfig(
      poolAccount,
      address(tokenIn)
    );
    assertEq(perOrderCap, 0);
  }

  // Config-gated draws

  function test_drawRequiresResolverRole() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    bytes32 resolverRole = pool.RESOLVER_ROLE();

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector,
        funder,
        resolverRole
      )
    );
    vm.prank(funder);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRequiresAccountAllowlist() public {
    _deposit(poolAccount, 100);
    // Config exists, but the resolver was never allowlisted by the account
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: 200,
        authorizer: authorizer,
        expiry: 0
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.ResolverNotAllowed.selector,
        poolAccount,
        resolver
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawSpendsBalanceWithinConfigAndRecordsDraw() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, 80, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.expectEmit(address(pool));
    emit FundingPool.Drawn(
      _order(requestHash),
      poolAccount,
      address(tokenIn),
      requestHash,
      resolver,
      DrawLegKind.FIXED,
      0,
      30
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      requestHash,
      0,
      DrawLegKind.FIXED
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 70);
    assertEq(tokenIn.balanceOf(resolver), 30);
    assertTrue(pool.drawRecords(_order(requestHash), poolAccount, 0));
    assertEq(
      pool.orderDraws(_order(requestHash), poolAccount, address(tokenIn)),
      30
    );
    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, 50);
  }

  function test_drawRejectsSecondDrawForSameLeg() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      requestHash,
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.AlreadyDrawn.selector,
        _order(requestHash),
        poolAccount,
        0
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      requestHash,
      0,
      DrawLegKind.FIXED
    );

    // A different order draws independently
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 80);
  }

  function test_drawsFundMultipleLegsOfOneOrderWithinCap() public {
    // One order may draw the same account across several legs — the spec's
    // composed fixed + shortfall shape — with the cap bounding the sum
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      requestHash,
      0,
      DrawLegKind.FIXED
    );
    _debit(
      poolAccount,
      address(tokenIn),
      20,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 50);
    assertTrue(pool.drawRecords(_order(requestHash), poolAccount, 0));
    assertTrue(pool.drawRecords(_order(requestHash), poolAccount, 1));
    assertEq(
      pool.orderDraws(_order(requestHash), poolAccount, address(tokenIn)),
      50
    );
  }

  function test_drawRejectsAmountAbovePerOrderCap() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.PerOrderCapExceeded.selector,
        poolAccount,
        address(tokenIn),
        51,
        50
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      51,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRejectsLegsSummingAbovePerOrderCap() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      requestHash,
      0,
      DrawLegKind.FIXED
    );

    // The second leg fits the cap alone but not summed with the first
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.PerOrderCapExceeded.selector,
        poolAccount,
        address(tokenIn),
        55,
        50
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      25,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );

    // A fresh order's draws are summed independently
    _debit(
      poolAccount,
      address(tokenIn),
      25,
      keccak256("request-2"),
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();
  }

  function test_drawSumsPerOrderCapPerToken() public {
    // The cap is per (account, token): one order drawing two tokens gets each
    // token's own ceiling rather than a meaningless cross-token sum
    _deposit(poolAccount, 100);
    tokenOut.mintFor(100, funder);
    vm.startPrank(funder);
    tokenOut.approve(address(pool), 100);
    pool.depositFor(poolAccount, address(tokenOut), 100);
    vm.stopPrank();

    _configurePoolAccount(50, type(uint256).max, 0);
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenOut),
      DrawConfig({
        perOrderCap: 50,
        budget: type(uint256).max,
        authorizer: authorizer,
        expiry: 0
      })
    );

    bytes32 requestHash = keccak256("request-1");
    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      50,
      requestHash,
      0,
      DrawLegKind.FIXED
    );
    _debit(
      poolAccount,
      address(tokenOut),
      50,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(
      pool.orderDraws(_order(requestHash), poolAccount, address(tokenIn)),
      50
    );
    assertEq(
      pool.orderDraws(_order(requestHash), poolAccount, address(tokenOut)),
      50
    );
  }

  function test_drawRejectsAmountAboveRemainingBudget() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, 40, 0);

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.BudgetExceeded.selector,
        poolAccount,
        address(tokenIn),
        30,
        10
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();
  }

  function test_drawDoesNotDecrementUnlimitedBudget() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);

    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    (, uint256 budget, , ) = pool.drawConfig(poolAccount, address(tokenIn));
    assertEq(budget, type(uint256).max);
  }

  function test_drawRejectsExpiredConfig() public {
    _deposit(poolAccount, 100);
    uint64 expiry = uint64(block.timestamp + 100);
    _configurePoolAccount(50, type(uint256).max, expiry);

    vm.warp(block.timestamp + 101);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawConfigExpired.selector,
        poolAccount,
        address(tokenIn),
        expiry
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRejectsUnconfiguredToken() public {
    // An unconfigured token has neither an authorizer nor a cap, and the
    // missing authorizer is the first gate it fails: allowlisting a resolver
    // is not on its own a grant over any token
    _deposit(poolAccount, 100);
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, true);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.NoAuthorizer.selector,
        poolAccount,
        address(tokenIn)
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRejectsInsufficientAccountBalance() public {
    // The pool is rich overall, but the pool account holds only 20
    _deposit(poolAccount, 20);
    _deposit(withdrawer, 500);
    _configurePoolAccount(50, type(uint256).max, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InsufficientBalance.selector,
        poolAccount,
        address(tokenIn),
        30,
        20
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawBlockedWhenPaused() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);

    vm.prank(owner);
    pool.pause();

    vm.expectRevert(Pausable.EnforcedPause.selector);
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    // Config management stays open while paused so an account can always
    // tighten or revoke its guardrails
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, false);
    assertFalse(pool.drawResolvers(poolAccount, resolver));
  }

  function test_drawRejectsZeroValues() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);

    vm.startPrank(resolver);
    vm.expectRevert(FundingPool.ZeroAddress.selector);
    _debit(
      address(0),
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(FundingPool.ZeroAddress.selector);
    _debit(
      poolAccount,
      address(0),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(FundingPool.ZeroAmount.selector);
    _debit(
      poolAccount,
      address(tokenIn),
      0,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();
  }

  function test_adminPauseBlocksInflowsButNotWithdrawals() public {
    _deposit(withdrawer, 100);
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    tokenIn.mintFor(50, resolver);

    vm.prank(owner);
    pool.pause();

    // Draws, deposits, and credits are all blocked while paused
    vm.prank(resolver);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    vm.startPrank(funder);
    tokenIn.approve(address(pool), 50);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    pool.depositFor(poolAccount, address(tokenIn), 50);
    vm.stopPrank();

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 50);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    pool.credit(
      poolAccount,
      address(tokenIn),
      50,
      address(0),
      0,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    // Both withdrawal paths stay open so funds can always leave the pool
    vm.prank(withdrawer);
    pool.withdraw(address(tokenIn), 25, withdrawer);
    assertEq(tokenIn.balanceOf(withdrawer), 25);

    PoolWithdrawal memory withdrawal = _withdrawal(80, 1);
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, poolAccountPk));
    assertEq(tokenIn.balanceOf(recipient), 80);
  }

  // Adversarial: credit attribution (DEC-1675)

  function test_creditIsPureAttributionIndependentOfDrawGates() public {
    // credit is the refund/surplus path and must not depend on the draw gates:
    // an in-flight settlement credits back to an account whose config may have
    // expired or whose allowlist a race could have flipped. Only RESOLVER_ROLE
    // and the pause gate it.
    tokenIn.mintFor(40, resolver);
    // No config, no allowlist, and an expiry already in the past
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({perOrderCap: 0, budget: 0, authorizer: authorizer, expiry: 1})
    );

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 40);
    pool.credit(
      poolAccount,
      address(tokenIn),
      40,
      address(0),
      0,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 40);
  }

  function test_creditCreditsOnlyTheReceivedAmount() public {
    // The received-amount guard must hold on the credit path too, or a
    // fee-on-transfer surplus refund would attribute more than the pool holds
    FeeOnTransferToken feeToken = new FeeOnTransferToken(100);
    feeToken.mint(resolver, 100);

    vm.startPrank(resolver);
    feeToken.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit FundingPool.Credited(
      address(0),
      poolAccount,
      address(feeToken),
      keccak256("request"),
      resolver,
      DrawLegKind.FIXED,
      0,
      99,
      0,
      0
    );
    pool.credit(
      poolAccount,
      address(feeToken),
      100,
      address(0),
      0,
      keccak256("request"),
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(feeToken)), 99);
    assertEq(feeToken.balanceOf(address(pool)), 99);
  }

  // Adversarial: cap / budget boundaries (DEC-1675)

  function test_drawAtExactCapAndExactBudgetBoundaries() public {
    // Draw exactly the per-order cap, exactly draining the budget; the next
    // draw of even 1 unit is refused against the now-zero budget
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, 50, 0);

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      50,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    (, uint256 budgetAfter, , ) = pool.drawConfig(
      poolAccount,
      address(tokenIn)
    );
    assertEq(budgetAfter, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.BudgetExceeded.selector,
        poolAccount,
        address(tokenIn),
        1,
        0
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      1,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 50);
  }

  /// @dev Mirrored by the `DrawConfigUpdate`, `DrawResolverUpdate` and
  ///      `DrawRevocation` typehash tests in
  ///      packages/sdk/test/funding-pool.test.ts — accounts sign these type
  ///      strings off-chain, so both sides must derive the same typehashes
  function test_drawConfigTypehashesMatchSdkFixtures() public view {
    assertEq(
      pool.DRAW_CONFIG_UPDATE_TYPEHASH(),
      0x342c027017bc0f827fe315c4d4c6f2e19aba6699bb67191b1009ed32e7a839c1
    );
    assertEq(
      pool.DRAW_RESOLVER_UPDATE_TYPEHASH(),
      0x3f1aa20f0d81c90a3255ec38475748a2f4263dfe9911e18e021d5caf84cfa2b1
    );
    assertEq(
      pool.DRAW_REVOCATION_TYPEHASH(),
      0x143edb3c92ecc7e1e6722be4c91478cf0bebc79b9fdf1cc651ebd713d025aa0e
    );
  }

  /// @dev Mirrored by the `DrawConfigUpdate`, `DrawResolverUpdate` and
  ///      `DrawRevocation` EIP-712 shape tests in
  ///      packages/sdk/test/funding-pool.test.ts — accounts sign these
  ///      digests off-chain, so both sides must agree byte for byte
  function test_drawConfigHashesMatchSdkFixtures() public {
    FundingPool fixturePool = FundingPool(
      address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f)
    );
    vm.etch(address(fixturePool), address(pool).code);
    assertEq(
      fixturePool.hashDrawConfigUpdate(
        DrawConfigUpdate({
          account: 0x3333333333333333333333333333333333333333,
          token: 0x4444444444444444444444444444444444444444,
          authorizer: 0x2222222222222222222222222222222222222222,
          perOrderCap: 50_000_000,
          budget: 2_000_000_000,
          expiry: 1_900_000_000,
          epoch: 3,
          nonce: 7,
          deadline: 2_000_000_000
        })
      ),
      0xcd5f661b4b25090775010e3ef9ed18007115af07aadfb22c47dd5311a76dd9d3
    );
    assertEq(
      fixturePool.hashDrawResolverUpdate(
        DrawResolverUpdate({
          account: 0x3333333333333333333333333333333333333333,
          resolver: 0x5555555555555555555555555555555555555555,
          allowed: true,
          epoch: 3,
          nonce: 8,
          deadline: 2_000_000_000
        })
      ),
      0x39c3126664603b97648fc979cef3b8a15727408dc7d85ba8cee683ebc9de3641
    );
    assertEq(
      fixturePool.hashDrawRevocation(
        DrawRevocation({
          account: 0x3333333333333333333333333333333333333333,
          epoch: 3,
          nonce: 9,
          deadline: 2_000_000_000
        })
      ),
      0xfcb95862fa6fe1baf2ad1546bccd96e5af5cba8bf4dd2d51426288f241b50ea6
    );
  }

  /// @dev Mirrored by `hashes the Solidity PoolWithdrawal EIP-712 shape` in
  ///      packages/sdk/test/funding-pool.test.ts — accounts sign this digest
  ///      off-chain, so both sides must agree byte for byte
  function test_withdrawalHashMatchesSdkFixture() public {
    FundingPool fixturePool = FundingPool(
      address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f)
    );
    vm.etch(address(fixturePool), address(pool).code);
    assertEq(
      fixturePool.hashWithdrawal(
        PoolWithdrawal({
          account: 0x3333333333333333333333333333333333333333,
          token: 0x4444444444444444444444444444444444444444,
          amount: 1_000_000,
          recipient: 0x5555555555555555555555555555555555555555,
          nonce: 7,
          deadline: 2_000_000_000
        })
      ),
      0x347fc83e26bcfb55a01c19ab40f48bcdfee43a6a83b647e20b6743977611801a
    );
  }

  function test_drawAuthorizationHashMatchesSdkFixture() public {
    FundingPool fixturePool = FundingPool(
      address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f)
    );
    vm.etch(address(fixturePool), address(pool).code);

    assertEq(
      fixturePool.hashDrawAuthorization(
        DrawAuthorization({
          account: 0x3333333333333333333333333333333333333333,
          orderAddress: 0x9999999999999999999999999999999999999999,
          planHash: bytes32(uint256(1)),
          nonce: 7,
          deadline: 1_900_000_000
        })
      ),
      0x5f1c6995884f4040d0720471c804c403f6d83c7f14989b943dd32f32cab7e734
    );
  }

  /// @dev Mirrored by `encodes the DrawAuthorization envelope` in
  ///      packages/sdk/test/funding-pool.test.ts — the envelope is what the
  ///      relayer ships per leg, so both sides must lay it out identically
  function test_drawAuthorizationEnvelopeMatchesSdkFixture() public pure {
    DrawAuthorization memory authorization = DrawAuthorization({
      account: 0x3333333333333333333333333333333333333333,
      orderAddress: 0x9999999999999999999999999999999999999999,
      planHash: bytes32(uint256(1)),
      nonce: 7,
      deadline: 1_900_000_000
    });
    assertEq(
      keccak256(abi.encode(authorization, hex"aabbcc")),
      0x12e1e65c98713446c6e1af1aa89bb5db05e61f49175ee934234b662baa5fba82
    );
  }

  // Adversarial: per-order draw authorization (DEC-1696)

  function test_drawRequiresAnAuthorizationFromTheNamedAuthorizer() public {
    // Config, cap, budget, balance and resolver allowlist all satisfied: the
    // authorization is the only thing missing, and it is enough to refuse
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawAuthorization.selector,
        poolAccount,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      ""
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationSignedByAnyoneElse() public {
    // The account's own signature does not substitute for its authorizer's:
    // the config names who may authorize orders, and only that key counts
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawAuthorization.selector,
        poolAccount,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorization(
        poolAccount,
        _order(keccak256("request")),
        poolAccountPk
      )
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationMintedForAnotherOrder() public {
    // An authorization is scoped to one order, so a signature obtained for a
    // real order cannot be carried over to fund a different one
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    bytes memory otherOrderAuthorization = _signDrawAuthorization(
      poolAccount,
      _order(keccak256("other-order")),
      authorizerPk
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawAuthorization.selector,
        poolAccount,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      otherOrderAuthorization
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationMintedForAnotherAccount() public {
    // The authorized account is part of the signed message, so an
    // authorization for one account cannot redirect a draw to another
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawAuthorization.selector,
        poolAccount,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorization(
        recipient,
        _order(keccak256("request")),
        authorizerPk
      )
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_accountRevokesDrawsByZeroingItsAuthorizer() public {
    // Zeroing the authorizer closes the token without touching the cap, so an
    // account can stand down its operator and keep its guardrails on file
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);

    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: UNLIMITED_BUDGET,
        authorizer: address(0),
        expiry: 0
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.NoAuthorizer.selector,
        poolAccount,
        address(tokenIn)
      )
    );
    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    (uint256 capAfterRevoking, , , ) = pool.drawConfig(
      poolAccount,
      address(tokenIn)
    );
    assertEq(capAfterRevoking, 50);
    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_authorizerMayBeAnErc1271Wallet() public {
    // Authorizers are ordinary wallets, so a contract signer works — the same
    // latitude the config and withdrawal messages already allow
    (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey(
      "authorizerWalletSigner"
    );
    MockErc1271Wallet wallet = new MockErc1271Wallet(walletSigner);

    _deposit(poolAccount, 100);
    vm.startPrank(poolAccount);
    pool.setDrawResolver(resolver, true);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: UNLIMITED_BUDGET,
        authorizer: address(wallet),
        expiry: 0
      })
    );
    vm.stopPrank();

    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorization(
        poolAccount,
        _order(keccak256("request")),
        walletSignerPk
      )
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 90);
  }

  // Adversarial: plan-bound, revocable draw authorization (DEC-1955, SEC-166)

  function test_drawRejectsAuthorizationSignedForAnotherPlan() public {
    // The reported drain: an authorization minted for the order is spent on a
    // plan the authorizer never saw. Binding the plan hash closes it — the
    // resolver hands the pool the hash of the committed plan it is executing,
    // and the signature must be over that exact value
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    DrawAuthorization memory authorization = _drawAuthorization(
      poolAccount,
      _order(keccak256("request"))
    );
    authorization.planHash = keccak256("substituted plan");

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawAuthorizationPlanMismatch.selector,
        PLAN_HASH,
        authorization.planHash
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorizationFields(authorization, authorizerPk)
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_oneAuthorizationFundsEveryLegOfItsPlan() public {
    // The statement covers the plan, not a leg: two legs of one order naming
    // the same account carry the same envelope, and the per-leg draw records
    // are what stop a leg from drawing twice
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    bytes memory envelope = _signDrawAuthorization(
      poolAccount,
      _order(keccak256("request")),
      authorizerPk
    );

    vm.startPrank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      envelope
    );
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      1,
      DrawLegKind.FIXED,
      envelope
    );
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.AlreadyDrawn.selector,
        _order(keccak256("request")),
        poolAccount,
        1
      )
    );
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      1,
      DrawLegKind.FIXED,
      envelope
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 80);
  }

  function test_drawNonceAdvancesOnEveryGuardrailChange() public {
    // Every path that changes an account's guardrails moves its nonce and
    // says so, so outstanding draw signatures never outlive the config they
    // were signed under and relayers have one signal to drop them on
    assertEq(pool.drawNonces(poolAccount), 0);

    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, 1);
    vm.prank(poolAccount);
    pool.setDrawResolver(resolver, true);

    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, 2);
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: UNLIMITED_BUDGET,
        authorizer: authorizer,
        expiry: 0
      })
    );

    DrawConfigUpdate memory update = _configUpdate(50, 3);
    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, 3);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    DrawResolverUpdate memory allowlist = _resolverUpdate(true, 4);
    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, 4);
    vm.prank(relayer);
    pool.setDrawResolver(
      allowlist,
      _signResolverUpdate(allowlist, poolAccountPk)
    );

    uint256 revoked = _revocationNonce(poolAccount);
    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, revoked);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(revoked);

    assertEq(pool.drawNonces(poolAccount), revoked);
  }

  function testFuzz_drawAuthorizationDiesWithAnyGuardrailChange(
    uint8 change
  ) public {
    // A signature minted under one nonce is refused after any change to the
    // account's guardrails — even an unrelated token's config, even a no-op
    // rewrite — and after an explicit revocation. The account never has to
    // chase down an outstanding signature to make a change stick
    change = uint8(bound(change, 0, 6));
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    bytes memory envelope = _signDrawAuthorization(
      poolAccount,
      _order(keccak256("request")),
      authorizerPk
    );
    uint256 nonceBefore = pool.drawNonces(poolAccount);

    if (change == 6) {
      DrawRevocation memory revocation = _revocation(poolAccount);
      pool.revokeDrawAuthorizations(
        revocation,
        _signRevocation(revocation, poolAccountPk)
      );
    } else if (change == 0) {
      vm.prank(poolAccount);
      pool.revokeDrawAuthorizations(_revocationNonce(poolAccount));
    } else if (change == 1) {
      // Same values, rewritten
      _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    } else if (change == 2) {
      vm.prank(poolAccount);
      pool.setDrawConfig(
        address(tokenOut),
        DrawConfig({
          perOrderCap: 1,
          budget: UNLIMITED_BUDGET,
          authorizer: authorizer,
          expiry: 0
        })
      );
    } else if (change == 3) {
      // Allowlisting an unrelated resolver, the drawing one stays allowed
      vm.prank(poolAccount);
      pool.setDrawResolver(recipient, true);
    } else if (change == 4) {
      DrawConfigUpdate memory update = _configUpdate(50, nonceBefore + 1);
      vm.prank(relayer);
      pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));
    } else {
      DrawResolverUpdate memory allowlist = _resolverUpdate(
        true,
        nonceBefore + 1
      );
      vm.prank(relayer);
      pool.setDrawResolver(
        allowlist,
        _signResolverUpdate(allowlist, poolAccountPk)
      );
    }
    uint256 nonceAfter = pool.drawNonces(poolAccount);
    assertGt(nonceAfter, nonceBefore);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawAuthorizationNonceMismatch.selector,
        nonceAfter,
        nonceBefore
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      envelope
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_revokeDrawAuthorizationsIsAccountScopedAndUnpaused() public {
    // Revoking is per account and, like every other guardrail, available
    // while the pool is paused
    vm.prank(owner);
    pool.pause();

    uint256 revoked = _revocationNonce(recipient);
    vm.prank(recipient);
    pool.revokeDrawAuthorizations(revoked);

    assertEq(pool.drawNonces(recipient), revoked);
    assertEq(pool.drawNonces(poolAccount), 0);
  }

  function test_randomRevocationKillsAuthorizationsPresignedForNextNonces()
    public
  {
    // The authorizer can always guess the next nonces and hold signatures
    // for them; a revocation that lands at random cannot be pre-signed for
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    uint256 nonce = pool.drawNonces(poolAccount);
    address orderAddress = _order(keccak256("request"));

    // Authorizations pre-signed for the next nonces, `+1` first
    bytes[] memory presigned = new bytes[](3);
    for (uint256 i; i < presigned.length; ++i) {
      DrawAuthorization memory authorization = _drawAuthorization(
        poolAccount,
        orderAddress
      );
      authorization.nonce = nonce + 1 + i;
      presigned[i] = _signDrawAuthorizationFields(authorization, authorizerPk);
    }

    uint256 revoked = _revocationNonce(poolAccount);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(revoked);
    assertEq(pool.drawNonces(poolAccount), revoked);

    for (uint256 i; i < presigned.length; ++i) {
      vm.expectRevert(
        abi.encodeWithSelector(
          FundingPool.DrawAuthorizationNonceMismatch.selector,
          revoked,
          nonce + 1 + i
        )
      );
      vm.prank(resolver);
      _debitWithAuthorization(
        poolAccount,
        address(tokenIn),
        10,
        keccak256("request"),
        0,
        DrawLegKind.FIXED,
        presigned[i]
      );
    }
  }

  function test_signedRevocationJumpsToTheSignedNonce() public {
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    DrawRevocation memory revocation = _revocation(poolAccount);
    assertGe(revocation.nonce - pool.drawNonces(poolAccount), 1 << 32);
    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, revocation.nonce);
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(
      revocation,
      _signRevocation(revocation, poolAccountPk)
    );
    assertEq(pool.drawNonces(poolAccount), revocation.nonce);
  }

  function testFuzz_revocationNonceMustMoveForwardWithinTheJump(
    uint256 nonce
  ) public {
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    uint256 current = pool.drawNonces(poolAccount);
    uint256 minJump = pool.MIN_DRAW_NONCE_JUMP();
    uint256 maxJump = pool.MAX_DRAW_NONCE_JUMP();
    if (
      nonce <= current || nonce - current < minJump || nonce - current > maxJump
    ) {
      vm.expectRevert(
        abi.encodeWithSelector(
          FundingPool.InvalidRevocationNonce.selector,
          poolAccount,
          current,
          nonce
        )
      );
      vm.prank(poolAccount);
      pool.revokeDrawAuthorizations(nonce);
      assertEq(pool.drawNonces(poolAccount), current);
    } else {
      vm.prank(poolAccount);
      pool.revokeDrawAuthorizations(nonce);
      assertEq(pool.drawNonces(poolAccount), nonce);
    }
  }

  function test_revocationJumpBoundsAreInclusive() public {
    uint256 minJump = pool.MIN_DRAW_NONCE_JUMP();
    uint256 maxJump = pool.MAX_DRAW_NONCE_JUMP();
    assertEq(minJump, 1 << 32);
    assertEq(maxJump, type(uint64).max);

    // The guessable small steps, `+1` first, are refused outright
    uint256[2] memory small = [uint256(1), minJump - 1];
    for (uint256 i; i < small.length; ++i) {
      vm.expectRevert(
        abi.encodeWithSelector(
          FundingPool.InvalidRevocationNonce.selector,
          poolAccount,
          0,
          small[i]
        )
      );
      vm.prank(poolAccount);
      pool.revokeDrawAuthorizations(small[i]);
    }
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(minJump);
    assertEq(pool.drawNonces(poolAccount), minJump);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidRevocationNonce.selector,
        poolAccount,
        minJump,
        minJump + maxJump + 1
      )
    );
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(minJump + maxJump + 1);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(minJump + maxJump);
    assertEq(pool.drawNonces(poolAccount), minJump + maxJump);

    // The account keeps moving after the widest jump
    DrawConfigUpdate memory next = _configUpdate(50, minJump + maxJump + 1);
    vm.prank(relayer);
    pool.setDrawConfig(next, _signConfigUpdate(next, poolAccountPk));
    assertEq(pool.drawNonces(poolAccount), minJump + maxJump + 1);
  }

  function test_signedRevocationJumpIsMeasuredAtExecution() public {
    // The jump bounds apply to the nonce current when the revocation lands,
    // so a queued signed update that eats into a minimal gap invalidates it
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    uint256 current = pool.drawNonces(poolAccount);
    uint256 minJump = pool.MIN_DRAW_NONCE_JUMP();
    DrawRevocation memory revocation = _revocation(poolAccount);
    revocation.nonce = current + minJump;
    bytes memory signature = _signRevocation(revocation, poolAccountPk);

    DrawConfigUpdate memory update = _configUpdate(50, current + 1);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidRevocationNonce.selector,
        poolAccount,
        current + 1,
        revocation.nonce
      )
    );
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(revocation, signature);
  }

  function test_signedRevocationWithSlackSurvivesAQueuedAdvance() public {
    // The SDK draws jumps from twice the minimum, so one queued advance
    // leaves the remaining gap well inside the bounds
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    uint256 current = pool.drawNonces(poolAccount);
    DrawRevocation memory revocation = _revocation(poolAccount);
    revocation.nonce = current + 2 * pool.MIN_DRAW_NONCE_JUMP();
    bytes memory signature = _signRevocation(revocation, poolAccountPk);

    DrawConfigUpdate memory update = _configUpdate(50, current + 1);
    vm.prank(relayer);
    pool.setDrawConfig(update, _signConfigUpdate(update, poolAccountPk));

    vm.expectEmit(address(pool));
    emit FundingPool.DrawNonceAdvanced(poolAccount, revocation.nonce);
    vm.prank(relayer);
    pool.revokeDrawAuthorizations(revocation, signature);
    assertEq(pool.drawNonces(poolAccount), revocation.nonce);
  }

  function test_plusOneRevocationIsRefused() public {
    // `+1` is the nonce an authorizer can always pre-sign for, so the pool
    // refuses it rather than let a revocation that kills nothing go through
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    uint256 nonce = pool.drawNonces(poolAccount);
    DrawAuthorization memory authorization = _drawAuthorization(
      poolAccount,
      _order(keccak256("request"))
    );
    authorization.nonce = nonce + 1;
    bytes memory presigned = _signDrawAuthorizationFields(
      authorization,
      authorizerPk
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidRevocationNonce.selector,
        poolAccount,
        nonce,
        nonce + 1
      )
    );
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(nonce + 1);

    DrawRevocation memory revocation = _revocation(poolAccount);
    revocation.nonce = nonce + 1;
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidRevocationNonce.selector,
        poolAccount,
        nonce,
        nonce + 1
      )
    );
    pool.revokeDrawAuthorizations(
      revocation,
      _signRevocation(revocation, poolAccountPk)
    );

    // A random jump is what retires the pre-signed authorization
    uint256 revoked = _revocationNonce(poolAccount);
    vm.prank(poolAccount);
    pool.revokeDrawAuthorizations(revoked);
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawAuthorizationNonceMismatch.selector,
        revoked,
        nonce + 1
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      presigned
    );
  }

  function test_drawRejectsExpiredAuthorization() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    vm.warp(1_000);
    DrawAuthorization memory authorization = _drawAuthorization(
      poolAccount,
      _order(keccak256("request"))
    );
    authorization.deadline = block.timestamp - 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.DrawAuthorizationExpired.selector,
        authorization.deadline
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorizationFields(authorization, authorizerPk)
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 100);
  }

  function test_drawRejectsZeroDeadlineAuthorization() public {
    // Zero is not "no deadline": an authorization has to say how long it
    // lives, so an unset field cannot mint an eternal one
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    DrawAuthorization memory authorization = _drawAuthorization(
      poolAccount,
      _order(keccak256("request"))
    );
    authorization.deadline = 0;

    vm.expectRevert(
      abi.encodeWithSelector(FundingPool.DrawAuthorizationExpired.selector, 0)
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorizationFields(authorization, authorizerPk)
    );
  }

  function test_drawAcceptsAuthorizationAtItsDeadline() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    DrawAuthorization memory authorization = _drawAuthorization(
      poolAccount,
      _order(keccak256("request"))
    );
    authorization.deadline = block.timestamp;

    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorizationFields(authorization, authorizerPk)
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 90);
  }

  function test_drawRejectsMalformedAuthorizationEnvelope() public {
    _deposit(poolAccount, 100);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.InvalidDrawAuthorization.selector,
        poolAccount,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      poolAccount,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      hex"deadbeef"
    );
  }

  function test_perOrderCapDoesNotRearmAcrossAttestationsOfOneOrder() public {
    // The records key on the order, not on the attestation digest driving it.
    // One order can be attested any number of times — the digest commits to
    // the resolver payload, so a fresh payload is a fresh digest — and the cap
    // has to bound the order across all of them
    _deposit(poolAccount, 1_000);
    _configurePoolAccount(50, UNLIMITED_BUDGET, 0);
    bytes32 orderSeed = keccak256("one-order");

    vm.startPrank(resolver);
    _debit(poolAccount, address(tokenIn), 50, orderSeed, 0, DrawLegKind.FIXED);

    // A second leg index under a different attestation of the same order: the
    // draw record is free, but the cap is already spent
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.PerOrderCapExceeded.selector,
        poolAccount,
        address(tokenIn),
        60,
        50
      )
    );
    _debit(poolAccount, address(tokenIn), 10, orderSeed, 1, DrawLegKind.FIXED);
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 950);
    assertEq(
      pool.orderDraws(_order(orderSeed), poolAccount, address(tokenIn)),
      50
    );
  }

  function test_budgetExhaustsAcrossManyOrdersThenBlocks() public {
    // The aggregate budget bounds the pool account across independent orders, not
    // just within one: three 30-unit draws exhaust a 90 budget, the fourth is
    // refused even though the balance and per-order cap still allow it
    _deposit(poolAccount, 1_000);
    _configurePoolAccount(50, 90, 0);

    vm.startPrank(resolver);
    for (uint256 i; i < 3; ++i) {
      _debit(
        poolAccount,
        address(tokenIn),
        30,
        keccak256(abi.encode("order", i)),
        0,
        DrawLegKind.FIXED
      );
    }

    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.BudgetExceeded.selector,
        poolAccount,
        address(tokenIn),
        30,
        0
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256(abi.encode("order", uint256(3))),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(poolAccount, address(tokenIn)), 910);
  }

  function test_reconfiguringConfigRefillsBudget() public {
    // A drained budget is not a permanent cap: only the account can re-sign a
    // fresh config, and doing so refills the budget. This is account-owned by
    // design, so the security model must not assume budget is monotonic
    _deposit(poolAccount, 1_000);
    _configurePoolAccount(50, 30, 0);

    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      30,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    // Budget exhausted; the account re-signs with a fresh budget
    vm.prank(poolAccount);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: 40,
        authorizer: authorizer,
        expiry: 0
      })
    );

    vm.prank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      40,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );

    assertEq(pool.balances(poolAccount, address(tokenIn)), 930);
  }

  // Adversarial: per-account isolation (DEC-1675)

  function test_drawRecordsAreScopedPerAccountForSameRequest() public {
    // One order draws two accounts: consuming the record for the first must
    // not consume it for the second, and re-drawing either within the same
    // order is refused
    _deposit(poolAccount, 100);
    _deposit(withdrawer, 100);
    _configurePoolAccount(50, type(uint256).max, 0);
    vm.startPrank(withdrawer);
    pool.setDrawResolver(resolver, true);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: 50,
        budget: type(uint256).max,
        authorizer: authorizer,
        expiry: 0
      })
    );
    vm.stopPrank();
    bytes32 requestHash = keccak256("shared-order");

    vm.startPrank(resolver);
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      requestHash,
      0,
      DrawLegKind.FIXED
    );
    // The second account is independently drawable for the same order and leg
    _debit(withdrawer, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);

    // Neither account's leg can be drawn a second time for this order
    vm.expectRevert(
      abi.encodeWithSelector(
        FundingPool.AlreadyDrawn.selector,
        _order(requestHash),
        poolAccount,
        0
      )
    );
    _debit(
      poolAccount,
      address(tokenIn),
      10,
      requestHash,
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertTrue(pool.drawRecords(_order(requestHash), poolAccount, 0));
    assertTrue(pool.drawRecords(_order(requestHash), withdrawer, 0));
  }

  function test_withdrawalNoncesAreScopedPerAccount() public {
    // Two accounts reusing the same nonce value do not collide: the nonce is
    // namespaced by account, so one account's withdrawal cannot burn another's
    (address otherPoolAccount, uint256 otherPoolAccountPk) = makeAddrAndKey(
      "otherPoolAccount"
    );
    _deposit(poolAccount, 100);
    _deposit(otherPoolAccount, 100);

    PoolWithdrawal memory first = _withdrawal(30, 1);
    PoolWithdrawal memory second = _withdrawal(40, 1);
    second.account = otherPoolAccount;

    vm.startPrank(relayer);
    pool.withdraw(first, _signWithdrawal(first, poolAccountPk));
    // Same nonce (1), different account — must succeed
    pool.withdraw(second, _signWithdrawal(second, otherPoolAccountPk));
    vm.stopPrank();

    assertTrue(pool.usedWithdrawalNonces(poolAccount, 1));
    assertTrue(pool.usedWithdrawalNonces(otherPoolAccount, 1));
    assertEq(tokenIn.balanceOf(recipient), 70);
  }

  // Adversarial: reentrancy (DEC-1675)

  function test_withdrawReentrancyIsBlocked() public {
    // A token that re-enters the pool from its transfer callback cannot open a
    // second withdrawal inside the first: the ReentrancyGuard reverts the
    // nested call and unwinds the whole withdrawal
    ReentrantWithdrawToken evilToken = new ReentrantWithdrawToken();
    evilToken.mint(address(this), 200);
    evilToken.approve(address(pool), 200);
    pool.depositFor(withdrawer, address(evilToken), 200);

    // Give the token the withdrawer role so its nested call clears the role
    // check and reaches the ReentrancyGuard — the guard, not the role, is what
    // must stop the recursion
    bytes32 withdrawerRole = pool.WITHDRAWER_ROLE();
    vm.prank(owner);
    pool.grantRole(withdrawerRole, address(evilToken));
    evilToken.arm(pool, recipient);

    vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    vm.prank(withdrawer);
    pool.withdraw(address(evilToken), 50, recipient);

    // The reverted attempt left the account balance fully intact
    assertEq(pool.balances(withdrawer, address(evilToken)), 200);
  }

  // Helpers

  function _deposit(address account, uint256 amount) internal {
    vm.startPrank(funder);
    tokenIn.approve(address(pool), amount);
    pool.depositFor(account, address(tokenIn), amount);
    vm.stopPrank();
  }

  function _configurePoolAccount(
    uint256 perOrderCap,
    uint256 budget,
    uint64 expiry
  ) internal {
    vm.startPrank(poolAccount);
    pool.setDrawResolver(resolver, true);
    pool.setDrawConfig(
      address(tokenIn),
      DrawConfig({
        perOrderCap: perOrderCap,
        budget: budget,
        authorizer: authorizer,
        expiry: expiry
      })
    );
    vm.stopPrank();
  }

  /// @notice Order address a seed stands for. Draw records and the per-order cap
  ///         key on the order, not on the attestation digest, so tests name
  ///         orders by seed and convert here
  function _order(bytes32 seed) internal pure returns (address orderAddress) {
    orderAddress = address(uint160(uint256(seed)));
  }

  /// @notice Draws through the pool with a valid authorization from the
  ///         pool account's configured authorizer, so tests exercising the other
  ///         gates are not all rewritten around the signature
  /// @dev Signs locally rather than reading the digest off the pool: most
  ///      callers arrive under a single-shot `vm.prank(resolver)`, which an
  ///      intervening external call would consume
  function _debit(
    address account,
    address token,
    uint256 amount,
    bytes32 orderSeed,
    uint256 legIndex,
    DrawLegKind kind
  ) internal {
    _debitWithAuthorization(
      account,
      token,
      amount,
      orderSeed,
      legIndex,
      kind,
      _signDrawAuthorization(account, _order(orderSeed), authorizerPk)
    );
  }

  /// @notice `_debit` with a caller-supplied authorization, for the cases where
  ///         the signature itself is what is under test
  function _debitWithAuthorization(
    address account,
    address token,
    uint256 amount,
    bytes32 orderSeed,
    uint256 legIndex,
    DrawLegKind kind,
    bytes memory authorization
  ) internal {
    pool.debit(
      DrawRequest({
        account: account,
        token: token,
        amount: amount,
        orderAddress: _order(orderSeed),
        requestHash: orderSeed,
        planHash: PLAN_HASH,
        legIndex: legIndex,
        kind: kind
      }),
      authorization
    );
  }

  /// @notice The statement the account's authorizer signs for a draw of
  ///         `PLAN_HASH` under the account's current nonce, valid for an hour
  function _drawAuthorization(
    address account,
    address orderAddress
  ) internal view returns (DrawAuthorization memory authorization) {
    authorization = DrawAuthorization({
      account: account,
      orderAddress: orderAddress,
      planHash: PLAN_HASH,
      nonce: _drawNonce(account),
      deadline: block.timestamp + 1 hours
    });
  }

  /// @notice Signs a fresh authorization for the account and order and wraps
  ///         it in the `abi.encode(DrawAuthorization, bytes signature)`
  ///         envelope the pool decodes
  function _signDrawAuthorization(
    address account,
    address orderAddress,
    uint256 signerPk
  ) internal view returns (bytes memory envelope) {
    envelope = _signDrawAuthorizationFields(
      _drawAuthorization(account, orderAddress),
      signerPk
    );
  }

  /// @notice Signs the authorization exactly as given, for the tests that
  ///         tamper with one of its fields
  function _signDrawAuthorizationFields(
    DrawAuthorization memory authorization,
    uint256 signerPk
  ) internal view returns (bytes memory envelope) {
    bytes32 structHash = keccak256(
      abi.encode(
        DRAW_AUTHORIZATION_TYPEHASH,
        authorization.account,
        authorization.orderAddress,
        authorization.planHash,
        authorization.nonce,
        authorization.deadline
      )
    );
    envelope = abi.encode(
      authorization,
      Eip712.sign(signerPk, poolDomain, structHash)
    );
  }

  /// @notice Reads an account's draw nonce straight from storage
  /// @dev A `pool.drawNonces(account)` call here would be the "next
  ///      call" a test's pending `vm.prank(resolver)` or `vm.expectRevert`
  ///      applies to, so the helpers that sign inside a debit cannot make it
  function _drawNonce(address account) internal view returns (uint256 nonce) {
    nonce = uint256(
      vm.load(address(pool), keccak256(abi.encode(account, drawNoncesSlot)))
    );
  }

  /// @notice Recovers the base slot of the `drawNonces` mapping by
  ///         recording which slot its getter reads, so the tests never
  ///         hardcode the pool's storage layout
  function _findDrawNoncesSlot() internal returns (uint256 slot) {
    vm.record();
    pool.drawNonces(poolAccount);
    (bytes32[] memory reads, ) = vm.accesses(address(pool));
    for (; slot < 256; ++slot) {
      if (keccak256(abi.encode(poolAccount, slot)) == reads[0]) {
        return slot;
      }
    }
    revert("drawNonces slot not found");
  }

  function _withdrawal(
    uint256 amount,
    uint256 nonce
  ) internal view returns (PoolWithdrawal memory withdrawal) {
    withdrawal = PoolWithdrawal({
      account: poolAccount,
      token: address(tokenIn),
      amount: amount,
      recipient: recipient,
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  /// @notice Deploys a Hub, mints `amount` of a token to the pool account
  ///         and returns the token's ERC-20 view
  function _hubView(
    uint256 amount
  ) internal returns (RelayHub hub, address viewToken, uint256 tokenId) {
    hub = new RelayHub(owner);
    tokenId = 42;
    vm.startPrank(owner);
    hub.grantRole(hub.OPERATOR_ROLE(), owner);
    hub.mint(poolAccount, tokenId, amount);
    vm.stopPrank();
    viewToken = hub.erc20Views(tokenId);
  }

  /// @notice Signs the Hub permit granting the pool `value` of `tokenId`
  function _signHubPermit(
    RelayHub hub,
    uint256 pk,
    address permitOwner,
    uint256 tokenId,
    uint256 value,
    uint256 deadline
  ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
    bytes32 structHash = keccak256(
      abi.encode(
        HUB_PERMIT_TYPEHASH,
        permitOwner,
        address(pool),
        tokenId,
        value,
        hub.nonces(permitOwner),
        deadline
      )
    );
    bytes32 digest = keccak256(
      abi.encodePacked(
        "\x19\x01",
        Eip712.domainSeparator("RelayHub", "1", block.chainid, address(hub)),
        structHash
      )
    );
    (v, r, s) = vm.sign(pk, digest);
  }

  function _signWithdrawal(
    PoolWithdrawal memory withdrawal,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        POOL_WITHDRAWAL_TYPEHASH,
        withdrawal.account,
        withdrawal.token,
        withdrawal.amount,
        withdrawal.recipient,
        withdrawal.nonce,
        withdrawal.deadline
      )
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }

  function _configEpoch(address account) internal view returns (uint256) {
    return
      uint256(
        vm.load(address(pool), keccak256(abi.encode(account, configEpochSlot)))
      );
  }

  function _configUpdate(
    uint256 perOrderCap,
    uint256 nonce
  ) internal view returns (DrawConfigUpdate memory update) {
    update = DrawConfigUpdate({
      account: poolAccount,
      token: address(tokenIn),
      authorizer: authorizer,
      perOrderCap: perOrderCap,
      budget: 200,
      expiry: 0,
      epoch: _configEpoch(poolAccount),
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _resolverUpdate(
    bool allowed,
    uint256 nonce
  ) internal view returns (DrawResolverUpdate memory update) {
    update = DrawResolverUpdate({
      account: poolAccount,
      resolver: resolver,
      allowed: allowed,
      epoch: _configEpoch(poolAccount),
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _signConfigUpdate(
    DrawConfigUpdate memory update,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        DRAW_CONFIG_UPDATE_TYPEHASH,
        update.account,
        update.token,
        update.authorizer,
        update.perOrderCap,
        update.budget,
        update.expiry,
        update.epoch,
        update.nonce,
        update.deadline
      )
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }

  function _signResolverUpdate(
    DrawResolverUpdate memory update,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        DRAW_RESOLVER_UPDATE_TYPEHASH,
        update.account,
        update.resolver,
        update.allowed,
        update.epoch,
        update.nonce,
        update.deadline
      )
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }
}
