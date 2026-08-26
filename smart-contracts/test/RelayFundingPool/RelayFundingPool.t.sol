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
  SponsorshipConfig,
  SponsorshipConfigUpdate,
  SponsorshipResolverUpdate
} from "../../contracts/funding-pools/IRelayFundingPool.sol";
import {RelayFundingPool} from "../../contracts/funding-pools/RelayFundingPool.sol";
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
  RelayFundingPool internal pool;
  address internal recipient;
  bool internal armed;

  constructor() ERC20("ReentrantWithdrawToken", "REENT") {}

  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }

  function arm(RelayFundingPool pool_, address recipient_) external {
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

contract RelayFundingPoolTest is BaseTest {
  bytes32 internal constant POOL_WITHDRAWAL_TYPEHASH =
    keccak256(
      "PoolWithdrawal(address account,address token,uint256 amount,address recipient,uint256 nonce,uint256 deadline)"
    );

  bytes32 internal constant SPONSORSHIP_CONFIG_UPDATE_TYPEHASH =
    keccak256(
      "SponsorshipConfigUpdate(address account,address token,address authorizer,uint256 perOrderCap,uint256 budget,uint64 expiry,uint256 nonce,uint256 deadline)"
    );

  bytes32 internal constant DRAW_AUTHORIZATION_TYPEHASH =
    keccak256("DrawAuthorization(address account,address orderAddress)");

  /// @notice Budget sentinel that disables aggregate budget accounting
  uint256 internal constant UNLIMITED_BUDGET = type(uint256).max;

  bytes32 internal constant SPONSORSHIP_RESOLVER_UPDATE_TYPEHASH =
    keccak256(
      "SponsorshipResolverUpdate(address account,address resolver,bool allowed,uint256 nonce,uint256 deadline)"
    );

  RelayFundingPool internal pool;
  MyToken internal tokenIn;
  MyToken internal tokenOut;

  address internal secondAdmin;
  address internal withdrawer;
  address internal resolver;
  address internal funder;
  address internal sponsor;
  uint256 internal sponsorPk;
  /// @notice Operator key the sponsor names as its draw authorizer
  address internal authorizer;
  uint256 internal authorizerPk;
  address internal recipient;
  address internal relayer;
  bytes32 internal poolDomain;

  function setUp() public override {
    super.setUp();
    secondAdmin = otherAccounts[0];
    withdrawer = otherAccounts[1];
    resolver = otherAccounts[2];
    funder = otherAccounts[3];
    (sponsor, sponsorPk) = makeAddrAndKey("sponsor");
    (authorizer, authorizerPk) = makeAddrAndKey("authorizer");
    recipient = otherAccounts[4];
    relayer = otherAccounts[5];

    pool = new RelayFundingPool(owner, withdrawer, resolver);
    tokenIn = new MyToken();
    tokenOut = new MyToken();
    tokenIn.mintFor(1_000, funder);

    poolDomain = Eip712.domainSeparator(
      "RelayFundingPool",
      "1",
      block.chainid,
      address(pool)
    );
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
    emit RelayFundingPool.Deposited(sponsor, address(tokenIn), funder, 100);
    pool.depositFor(sponsor, address(tokenIn), 100);
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
    assertEq(tokenIn.balanceOf(address(pool)), 100);
    // The funder deposited for the sponsor, so the funder holds no balance
    assertEq(pool.balances(funder, address(tokenIn)), 0);
  }

  function test_depositForIsPermissionless() public {
    // No role required: any funder can top up any account
    tokenIn.mintFor(50, relayer);
    vm.startPrank(relayer);
    tokenIn.approve(address(pool), 50);
    pool.depositFor(sponsor, address(tokenIn), 50);
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 50);
  }

  function test_depositForScopesBalancesPerAccountAndToken() public {
    tokenOut.mintFor(300, funder);
    _deposit(sponsor, 100);
    _deposit(withdrawer, 25);
    vm.startPrank(funder);
    tokenOut.approve(address(pool), 300);
    pool.depositFor(sponsor, address(tokenOut), 300);
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
    assertEq(pool.balances(sponsor, address(tokenOut)), 300);
    assertEq(pool.balances(withdrawer, address(tokenIn)), 25);
    assertEq(pool.balances(withdrawer, address(tokenOut)), 0);
  }

  function test_depositForRejectsZeroValues() public {
    vm.startPrank(funder);
    tokenIn.approve(address(pool), 100);

    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    pool.depositFor(address(0), address(tokenIn), 100);

    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    pool.depositFor(sponsor, address(0), 100);

    vm.expectRevert(RelayFundingPool.ZeroAmount.selector);
    pool.depositFor(sponsor, address(tokenIn), 0);
    vm.stopPrank();
  }

  function test_depositForCreditsOnlyTheReceivedAmount() public {
    // 100 bps transfer fee: a 100-token deposit delivers 99 to the pool
    FeeOnTransferToken feeToken = new FeeOnTransferToken(100);
    feeToken.mint(funder, 100);

    vm.startPrank(funder);
    feeToken.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit RelayFundingPool.Deposited(sponsor, address(feeToken), funder, 99);
    pool.depositFor(sponsor, address(feeToken), 100);
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(feeToken)), 99);
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
      sponsor,
      address(tokenIn),
      100,
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
    emit RelayFundingPool.Credited(
      keccak256("request"),
      sponsor,
      address(tokenIn),
      resolver,
      DrawLegKind.SHORTFALL_TO_TARGET,
      40
    );
    pool.credit(
      sponsor,
      address(tokenIn),
      40,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 40);
    assertEq(tokenIn.balanceOf(address(pool)), 40);
    assertEq(tokenIn.balanceOf(resolver), 0);
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
    _deposit(sponsor, 200);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InsufficientBalance.selector,
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
    _deposit(sponsor, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 1);
    bytes memory signature = _signWithdrawal(withdrawal, sponsorPk);

    // Any relayer may submit the account-signed message and pay its gas
    vm.expectEmit(address(pool));
    emit RelayFundingPool.Withdrawn(sponsor, recipient, address(tokenIn), 80);
    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);

    assertEq(pool.balances(sponsor, address(tokenIn)), 120);
    assertEq(tokenIn.balanceOf(recipient), 80);
    assertTrue(pool.usedWithdrawalNonces(sponsor, 1));
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
    _deposit(sponsor, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 2);
    bytes memory signature = _signWithdrawal(withdrawal, sponsorPk);

    vm.startPrank(relayer);
    pool.withdraw(withdrawal, signature);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.WithdrawalNonceUsed.selector,
        sponsor,
        2
      )
    );
    pool.withdraw(withdrawal, signature);
    vm.stopPrank();
  }

  function test_rejectsExpiredWithdrawal() public {
    _deposit(sponsor, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 3);
    withdrawal.deadline = block.timestamp - 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.WithdrawalExpired.selector,
        withdrawal.deadline
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, sponsorPk));
  }

  function test_rejectsTamperedWithdrawal() public {
    _deposit(sponsor, 200);
    PoolWithdrawal memory withdrawal = _withdrawal(80, 4);
    bytes memory signature = _signWithdrawal(withdrawal, sponsorPk);

    // Raise the amount after signing; the digest no longer matches
    withdrawal.amount = 200;

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidWithdrawal.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, signature);
  }

  function test_rejectsWithdrawalSignedByAnotherAccount() public {
    _deposit(sponsor, 200);
    (, uint256 strayPk) = makeAddrAndKey("stray");
    PoolWithdrawal memory withdrawal = _withdrawal(80, 5);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidWithdrawal.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, strayPk));
  }

  function test_rejectsWithdrawalExceedingAccountBalance() public {
    // The pool holds plenty overall, but the sponsor's account holds only 50
    _deposit(sponsor, 50);
    _deposit(withdrawer, 500);
    PoolWithdrawal memory withdrawal = _withdrawal(100, 6);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InsufficientBalance.selector,
        sponsor,
        address(tokenIn),
        100,
        50
      )
    );
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, sponsorPk));
  }

  function test_rejectsCrossPoolWithdrawalReplay() public {
    // A second pool with identical role members but a distinct EIP-712 domain
    RelayFundingPool otherPool = new RelayFundingPool(
      owner,
      withdrawer,
      resolver
    );
    tokenIn.mintFor(200, funder);
    vm.startPrank(funder);
    tokenIn.approve(address(otherPool), 200);
    otherPool.depositFor(sponsor, address(tokenIn), 200);
    vm.stopPrank();

    // Signature is bound to `pool`'s domain via `_signWithdrawal`
    PoolWithdrawal memory withdrawal = _withdrawal(80, 7);
    bytes memory signature = _signWithdrawal(withdrawal, sponsorPk);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidWithdrawal.selector,
        sponsor
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
    pool.depositFor(sponsor, viewToken, 500);
    vm.stopPrank();
    assertEq(pool.balances(sponsor, viewToken), 500);

    PoolWithdrawal memory withdrawal = _withdrawal(200, 1);
    withdrawal.token = viewToken;
    vm.prank(relayer);
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, sponsorPk));

    assertEq(pool.balances(sponsor, viewToken), 300);
    assertEq(hub.balanceOf(recipient, tokenId), 200);
    assertEq(hub.balanceOf(address(pool), tokenId), 300);
  }

  // Sponsorship configs

  function test_setSponsorshipConfigStoresAndEmits() public {
    vm.expectEmit(address(pool));
    emit RelayFundingPool.SponsorshipConfigSet(
      sponsor,
      address(tokenIn),
      authorizer,
      50,
      200,
      uint64(block.timestamp + 30 days)
    );
    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
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
    ) = pool.sponsorshipConfig(sponsor, address(tokenIn));
    assertEq(configAuthorizer, authorizer);
    assertEq(perOrderCap, 50);
    assertEq(budget, 200);
    assertEq(expiry, uint64(block.timestamp + 30 days));
  }

  function test_setSponsorshipResolverStoresAndEmits() public {
    assertFalse(pool.sponsorshipResolvers(sponsor, resolver));

    vm.expectEmit(address(pool));
    emit RelayFundingPool.SponsorshipResolverSet(sponsor, resolver, true);
    vm.prank(sponsor);
    pool.setSponsorshipResolver(resolver, true);
    assertTrue(pool.sponsorshipResolvers(sponsor, resolver));

    vm.prank(sponsor);
    pool.setSponsorshipResolver(resolver, false);
    assertFalse(pool.sponsorshipResolvers(sponsor, resolver));
  }

  function test_sponsorshipSettersRejectZeroAddresses() public {
    vm.startPrank(sponsor);
    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    pool.setSponsorshipConfig(
      address(0),
      SponsorshipConfig({
        perOrderCap: 1,
        budget: 1,
        authorizer: authorizer,
        expiry: 0
      })
    );
    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    pool.setSponsorshipResolver(address(0), true);
    vm.stopPrank();
  }

  // Account-signed sponsorship updates

  function test_accountSignedConfigUpdateStoresAndEmits() public {
    SponsorshipConfigUpdate memory update = _configUpdate(50, 1);
    bytes memory signature = _signConfigUpdate(update, sponsorPk);

    // Any relayer may submit the account-signed message and pay its gas
    vm.expectEmit(address(pool));
    emit RelayFundingPool.SponsorshipConfigSet(
      sponsor,
      address(tokenIn),
      authorizer,
      50,
      200,
      0
    );
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, signature);

    (
      uint256 perOrderCap,
      uint256 budget,
      address configAuthorizer,
      uint64 expiry
    ) = pool.sponsorshipConfig(sponsor, address(tokenIn));
    assertEq(configAuthorizer, authorizer);
    assertEq(perOrderCap, 50);
    assertEq(budget, 200);
    assertEq(expiry, 0);
    assertTrue(pool.usedSponsorshipNonces(sponsor, 1));
  }

  function test_accountSignedResolverUpdateStoresAndEmits() public {
    SponsorshipResolverUpdate memory update = _resolverUpdate(true, 1);
    bytes memory signature = _signResolverUpdate(update, sponsorPk);

    vm.expectEmit(address(pool));
    emit RelayFundingPool.SponsorshipResolverSet(sponsor, resolver, true);
    vm.prank(relayer);
    pool.setSponsorshipResolver(update, signature);

    assertTrue(pool.sponsorshipResolvers(sponsor, resolver));
    assertTrue(pool.usedSponsorshipNonces(sponsor, 1));

    // A follow-up signed message revokes the resolver again
    SponsorshipResolverUpdate memory revocation = _resolverUpdate(false, 2);
    vm.prank(relayer);
    pool.setSponsorshipResolver(
      revocation,
      _signResolverUpdate(revocation, sponsorPk)
    );
    assertFalse(pool.sponsorshipResolvers(sponsor, resolver));
  }

  function test_accountSignedUpdatesSupportErc1271Accounts() public {
    (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey(
      "walletSigner"
    );
    MockErc1271Wallet wallet = new MockErc1271Wallet(walletSigner);

    SponsorshipConfigUpdate memory update = _configUpdate(50, 1);
    update.account = address(wallet);
    vm.prank(relayer);
    pool.setSponsorshipConfig(
      update,
      _signConfigUpdate(update, walletSignerPk)
    );

    (uint256 perOrderCap, , , ) = pool.sponsorshipConfig(
      address(wallet),
      address(tokenIn)
    );
    assertEq(perOrderCap, 50);

    SponsorshipResolverUpdate memory allowlist = _resolverUpdate(true, 2);
    allowlist.account = address(wallet);
    vm.prank(relayer);
    pool.setSponsorshipResolver(
      allowlist,
      _signResolverUpdate(allowlist, walletSignerPk)
    );
    assertTrue(pool.sponsorshipResolvers(address(wallet), resolver));
  }

  function test_rejectsSponsorshipUpdateReplay() public {
    SponsorshipConfigUpdate memory update = _configUpdate(50, 3);
    bytes memory signature = _signConfigUpdate(update, sponsorPk);

    vm.startPrank(relayer);
    pool.setSponsorshipConfig(update, signature);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.SponsorshipNonceUsed.selector,
        sponsor,
        3
      )
    );
    pool.setSponsorshipConfig(update, signature);
    vm.stopPrank();
  }

  function test_sponsorshipNoncesAreSharedAcrossUpdateKinds() public {
    // Config and resolver updates consume one nonce space, so a stale message
    // of either kind cannot ride alongside a newer one reusing its nonce
    SponsorshipConfigUpdate memory update = _configUpdate(50, 4);
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, _signConfigUpdate(update, sponsorPk));

    SponsorshipResolverUpdate memory allowlist = _resolverUpdate(true, 4);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.SponsorshipNonceUsed.selector,
        sponsor,
        4
      )
    );
    vm.prank(relayer);
    pool.setSponsorshipResolver(
      allowlist,
      _signResolverUpdate(allowlist, sponsorPk)
    );
  }

  function test_rejectsExpiredSponsorshipUpdate() public {
    SponsorshipConfigUpdate memory update = _configUpdate(50, 5);
    update.deadline = block.timestamp - 1;

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.SponsorshipUpdateExpired.selector,
        update.deadline
      )
    );
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, _signConfigUpdate(update, sponsorPk));
  }

  function test_rejectsTamperedSponsorshipUpdate() public {
    SponsorshipConfigUpdate memory update = _configUpdate(50, 6);
    bytes memory signature = _signConfigUpdate(update, sponsorPk);

    // Raise the cap after signing; the digest no longer matches
    update.perOrderCap = 500;

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidSponsorshipUpdate.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, signature);
  }

  function test_rejectsSponsorshipUpdateSignedByAnotherAccount() public {
    (, uint256 strayPk) = makeAddrAndKey("stray");

    SponsorshipConfigUpdate memory update = _configUpdate(50, 7);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidSponsorshipUpdate.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, _signConfigUpdate(update, strayPk));

    SponsorshipResolverUpdate memory allowlist = _resolverUpdate(true, 8);
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidSponsorshipUpdate.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    pool.setSponsorshipResolver(
      allowlist,
      _signResolverUpdate(allowlist, strayPk)
    );
  }

  function test_rejectsCrossPoolSponsorshipUpdateReplay() public {
    // A second pool with identical role members but a distinct EIP-712 domain
    RelayFundingPool otherPool = new RelayFundingPool(
      owner,
      withdrawer,
      resolver
    );

    // Signature is bound to `pool`'s domain via `_signConfigUpdate`
    SponsorshipConfigUpdate memory update = _configUpdate(50, 9);
    bytes memory signature = _signConfigUpdate(update, sponsorPk);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidSponsorshipUpdate.selector,
        sponsor
      )
    );
    vm.prank(relayer);
    otherPool.setSponsorshipConfig(update, signature);
  }

  function test_signedSponsorshipUpdatesRejectZeroAddresses() public {
    SponsorshipConfigUpdate memory update = _configUpdate(50, 10);
    update.token = address(0);
    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, _signConfigUpdate(update, sponsorPk));

    SponsorshipResolverUpdate memory allowlist = _resolverUpdate(true, 11);
    allowlist.resolver = address(0);
    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    vm.prank(relayer);
    pool.setSponsorshipResolver(
      allowlist,
      _signResolverUpdate(allowlist, sponsorPk)
    );
  }

  function test_signedSponsorshipUpdatesWorkWhilePaused() public {
    // Guardrail management stays open while paused so an account can always
    // tighten or revoke via the relayed path too
    vm.prank(owner);
    pool.pause();

    SponsorshipConfigUpdate memory update = _configUpdate(0, 12);
    vm.prank(relayer);
    pool.setSponsorshipConfig(update, _signConfigUpdate(update, sponsorPk));

    (uint256 perOrderCap, , , ) = pool.sponsorshipConfig(
      sponsor,
      address(tokenIn)
    );
    assertEq(perOrderCap, 0);
  }

  // Config-gated draws

  function test_drawRequiresResolverRole() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);
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
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRequiresAccountAllowlist() public {
    _deposit(sponsor, 100);
    // Config exists, but the resolver was never allowlisted by the account
    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: 200,
        authorizer: authorizer,
        expiry: 0
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.ResolverNotAllowed.selector,
        sponsor,
        resolver
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawSpendsBalanceWithinConfigAndRecordsDraw() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, 80, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.expectEmit(address(pool));
    emit RelayFundingPool.Drawn(
      _order(requestHash),
      sponsor,
      address(tokenIn),
      requestHash,
      resolver,
      DrawLegKind.FIXED,
      0,
      30
    );
    vm.prank(resolver);
    _debit(sponsor, address(tokenIn), 30, requestHash, 0, DrawLegKind.FIXED);

    assertEq(pool.balances(sponsor, address(tokenIn)), 70);
    assertEq(tokenIn.balanceOf(resolver), 30);
    assertTrue(pool.drawRecords(_order(requestHash), sponsor, 0));
    assertEq(
      pool.orderDraws(_order(requestHash), sponsor, address(tokenIn)),
      30
    );
    (, uint256 budget, , ) = pool.sponsorshipConfig(sponsor, address(tokenIn));
    assertEq(budget, 50);
  }

  function test_drawRejectsSecondDrawForSameLeg() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.AlreadyDrawn.selector,
        requestHash,
        sponsor,
        0
      )
    );
    _debit(sponsor, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);

    // A different order draws independently
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 80);
  }

  function test_drawsFundMultipleLegsOfOneOrderWithinCap() public {
    // One order may draw the same account across several legs — the spec's
    // composed fixed + shortfall shape — with the cap bounding the sum
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 30, requestHash, 0, DrawLegKind.FIXED);
    _debit(
      sponsor,
      address(tokenIn),
      20,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 50);
    assertTrue(pool.drawRecords(_order(requestHash), sponsor, 0));
    assertTrue(pool.drawRecords(_order(requestHash), sponsor, 1));
    assertEq(
      pool.orderDraws(_order(requestHash), sponsor, address(tokenIn)),
      50
    );
  }

  function test_drawRejectsAmountAbovePerOrderCap() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        sponsor,
        address(tokenIn),
        51,
        50
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      51,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRejectsLegsSummingAbovePerOrderCap() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);
    bytes32 requestHash = keccak256("request-1");

    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 30, requestHash, 0, DrawLegKind.FIXED);

    // The second leg fits the cap alone but not summed with the first
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        sponsor,
        address(tokenIn),
        55,
        50
      )
    );
    _debit(
      sponsor,
      address(tokenIn),
      25,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );

    // A fresh order's draws are summed independently
    _debit(
      sponsor,
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
    _deposit(sponsor, 100);
    tokenOut.mintFor(100, funder);
    vm.startPrank(funder);
    tokenOut.approve(address(pool), 100);
    pool.depositFor(sponsor, address(tokenOut), 100);
    vm.stopPrank();

    _configureSponsor(50, type(uint256).max, 0);
    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenOut),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: type(uint256).max,
        authorizer: authorizer,
        expiry: 0
      })
    );

    bytes32 requestHash = keccak256("request-1");
    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 50, requestHash, 0, DrawLegKind.FIXED);
    _debit(
      sponsor,
      address(tokenOut),
      50,
      requestHash,
      1,
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(
      pool.orderDraws(_order(requestHash), sponsor, address(tokenIn)),
      50
    );
    assertEq(
      pool.orderDraws(_order(requestHash), sponsor, address(tokenOut)),
      50
    );
  }

  function test_drawRejectsAmountAboveRemainingBudget() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, 40, 0);

    vm.startPrank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.BudgetExceeded.selector,
        sponsor,
        address(tokenIn),
        30,
        10
      )
    );
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();
  }

  function test_drawDoesNotDecrementUnlimitedBudget() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);

    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    (, uint256 budget, , ) = pool.sponsorshipConfig(sponsor, address(tokenIn));
    assertEq(budget, type(uint256).max);
  }

  function test_drawRejectsExpiredConfig() public {
    _deposit(sponsor, 100);
    uint64 expiry = uint64(block.timestamp + 100);
    _configureSponsor(50, type(uint256).max, expiry);

    vm.warp(block.timestamp + 101);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.SponsorshipConfigExpired.selector,
        sponsor,
        address(tokenIn),
        expiry
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
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
    _deposit(sponsor, 100);
    vm.prank(sponsor);
    pool.setSponsorshipResolver(resolver, true);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.NoAuthorizer.selector,
        sponsor,
        address(tokenIn)
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawRejectsInsufficientAccountBalance() public {
    // The pool is rich overall, but the sponsor's account holds only 20
    _deposit(sponsor, 20);
    _deposit(withdrawer, 500);
    _configureSponsor(50, type(uint256).max, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InsufficientBalance.selector,
        sponsor,
        address(tokenIn),
        30,
        20
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );
  }

  function test_drawBlockedWhenPaused() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);

    vm.prank(owner);
    pool.pause();

    vm.expectRevert(Pausable.EnforcedPause.selector);
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    // Config management stays open while paused so an account can always
    // tighten or revoke its guardrails
    vm.prank(sponsor);
    pool.setSponsorshipResolver(resolver, false);
    assertFalse(pool.sponsorshipResolvers(sponsor, resolver));
  }

  function test_drawRejectsZeroValues() public {
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);

    vm.startPrank(resolver);
    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    _debit(
      address(0),
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    vm.expectRevert(RelayFundingPool.ZeroAddress.selector);
    _debit(sponsor, address(0), 10, keccak256("request"), 0, DrawLegKind.FIXED);

    vm.expectRevert(RelayFundingPool.ZeroAmount.selector);
    _debit(
      sponsor,
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
    _deposit(sponsor, 100);
    _configureSponsor(50, type(uint256).max, 0);
    tokenIn.mintFor(50, resolver);

    vm.prank(owner);
    pool.pause();

    // Draws, deposits, and credits are all blocked while paused
    vm.prank(resolver);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    vm.startPrank(funder);
    tokenIn.approve(address(pool), 50);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    pool.depositFor(sponsor, address(tokenIn), 50);
    vm.stopPrank();

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 50);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    pool.credit(
      sponsor,
      address(tokenIn),
      50,
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
    pool.withdraw(withdrawal, _signWithdrawal(withdrawal, sponsorPk));
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
    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 0,
        budget: 0,
        authorizer: authorizer,
        expiry: 1
      })
    );

    vm.startPrank(resolver);
    tokenIn.approve(address(pool), 40);
    pool.credit(
      sponsor,
      address(tokenIn),
      40,
      keccak256("request"),
      DrawLegKind.SHORTFALL_TO_TARGET
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 40);
  }

  function test_creditCreditsOnlyTheReceivedAmount() public {
    // The received-amount guard must hold on the credit path too, or a
    // fee-on-transfer surplus refund would attribute more than the pool holds
    FeeOnTransferToken feeToken = new FeeOnTransferToken(100);
    feeToken.mint(resolver, 100);

    vm.startPrank(resolver);
    feeToken.approve(address(pool), 100);
    vm.expectEmit(address(pool));
    emit RelayFundingPool.Credited(
      keccak256("request"),
      sponsor,
      address(feeToken),
      resolver,
      DrawLegKind.FIXED,
      99
    );
    pool.credit(
      sponsor,
      address(feeToken),
      100,
      keccak256("request"),
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(feeToken)), 99);
    assertEq(feeToken.balanceOf(address(pool)), 99);
  }

  // Adversarial: cap / budget boundaries (DEC-1675)

  function test_drawAtExactCapAndExactBudgetBoundaries() public {
    // Draw exactly the per-order cap, exactly draining the budget; the next
    // draw of even 1 unit is refused against the now-zero budget
    _deposit(sponsor, 100);
    _configureSponsor(50, 50, 0);

    vm.startPrank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      50,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    (, uint256 budgetAfter, , ) = pool.sponsorshipConfig(
      sponsor,
      address(tokenIn)
    );
    assertEq(budgetAfter, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.BudgetExceeded.selector,
        sponsor,
        address(tokenIn),
        1,
        0
      )
    );
    _debit(
      sponsor,
      address(tokenIn),
      1,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 50);
  }

  /// @dev Mirrored by `hashes the Solidity DrawAuthorization EIP-712 shape` in
  ///      packages/sdk/test/funding-pool.test.ts — the platform derives this
  ///      digest off-chain to sign, so both sides must agree byte for byte
  function test_drawAuthorizationHashMatchesSdkFixture() public {
    RelayFundingPool fixturePool = RelayFundingPool(
      address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f)
    );
    vm.etch(address(fixturePool), address(pool).code);

    assertEq(
      fixturePool.hashDrawAuthorization(
        DrawAuthorization({
          account: 0x3333333333333333333333333333333333333333,
          orderAddress: 0x9999999999999999999999999999999999999999
        })
      ),
      0xb530232c7a8705c344cff4fd54c62e3b276647566e8013ff846baa11aa690a8e
    );
  }

  // Adversarial: per-order draw authorization (DEC-1696)

  function test_drawRequiresAnAuthorizationFromTheNamedAuthorizer() public {
    // Config, cap, budget, balance and resolver allowlist all satisfied: the
    // authorization is the only thing missing, and it is enough to refuse
    _deposit(sponsor, 100);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        sponsor,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      ""
    );

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationSignedByAnyoneElse() public {
    // The account's own signature does not substitute for its authorizer's:
    // the config names who may authorize orders, and only that key counts
    _deposit(sponsor, 100);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        sponsor,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorization(sponsor, _order(keccak256("request")), sponsorPk)
    );

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationMintedForAnotherOrder() public {
    // An authorization is scoped to one order, so a signature obtained for a
    // real order cannot be carried over to fund a different one
    _deposit(sponsor, 100);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);
    bytes memory otherOrderAuthorization = _signDrawAuthorization(
      sponsor,
      _order(keccak256("other-order")),
      authorizerPk
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        sponsor,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      otherOrderAuthorization
    );

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
  }

  function test_drawRejectsAuthorizationMintedForAnotherAccount() public {
    // The authorized account is part of the signed message, so an
    // authorization for one account cannot redirect a draw to another
    _deposit(sponsor, 100);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.InvalidDrawAuthorization.selector,
        sponsor,
        authorizer,
        _order(keccak256("request"))
      )
    );
    vm.prank(resolver);
    _debitWithAuthorization(
      sponsor,
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

    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
  }

  function test_accountRevokesDrawsByZeroingItsAuthorizer() public {
    // Zeroing the authorizer closes the token without touching the cap, so an
    // account can stand down its operator and keep its guardrails on file
    _deposit(sponsor, 100);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);

    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: UNLIMITED_BUDGET,
        authorizer: address(0),
        expiry: 0
      })
    );

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.NoAuthorizer.selector,
        sponsor,
        address(tokenIn)
      )
    );
    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED
    );

    (uint256 capAfterRevoking, , , ) = pool.sponsorshipConfig(
      sponsor,
      address(tokenIn)
    );
    assertEq(capAfterRevoking, 50);
    assertEq(pool.balances(sponsor, address(tokenIn)), 100);
  }

  function test_authorizerMayBeAnErc1271Wallet() public {
    // Authorizers are ordinary wallets, so a contract signer works — the same
    // latitude the config and withdrawal messages already allow
    (address walletSigner, uint256 walletSignerPk) = makeAddrAndKey(
      "authorizerWalletSigner"
    );
    MockErc1271Wallet wallet = new MockErc1271Wallet(walletSigner);

    _deposit(sponsor, 100);
    vm.startPrank(sponsor);
    pool.setSponsorshipResolver(resolver, true);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: UNLIMITED_BUDGET,
        authorizer: address(wallet),
        expiry: 0
      })
    );
    vm.stopPrank();

    vm.prank(resolver);
    _debitWithAuthorization(
      sponsor,
      address(tokenIn),
      10,
      keccak256("request"),
      0,
      DrawLegKind.FIXED,
      _signDrawAuthorization(
        sponsor,
        _order(keccak256("request")),
        walletSignerPk
      )
    );

    assertEq(pool.balances(sponsor, address(tokenIn)), 90);
  }

  function test_perOrderCapDoesNotRearmAcrossAttestationsOfOneOrder() public {
    // The records key on the order, not on the attestation digest driving it.
    // One order can be attested any number of times — the digest commits to
    // the resolver payload, so a fresh payload is a fresh digest — and the cap
    // has to bound the order across all of them
    _deposit(sponsor, 1_000);
    _configureSponsor(50, UNLIMITED_BUDGET, 0);
    bytes32 orderSeed = keccak256("one-order");

    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 50, orderSeed, 0, DrawLegKind.FIXED);

    // A second leg index under a different attestation of the same order: the
    // draw record is free, but the cap is already spent
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.PerOrderCapExceeded.selector,
        sponsor,
        address(tokenIn),
        60,
        50
      )
    );
    _debit(sponsor, address(tokenIn), 10, orderSeed, 1, DrawLegKind.FIXED);
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 950);
    assertEq(pool.orderDraws(_order(orderSeed), sponsor, address(tokenIn)), 50);
  }

  function test_budgetExhaustsAcrossManyOrdersThenBlocks() public {
    // The aggregate budget bounds the sponsor across independent orders, not
    // just within one: three 30-unit draws exhaust a 90 budget, the fourth is
    // refused even though the balance and per-order cap still allow it
    _deposit(sponsor, 1_000);
    _configureSponsor(50, 90, 0);

    vm.startPrank(resolver);
    for (uint256 i; i < 3; ++i) {
      _debit(
        sponsor,
        address(tokenIn),
        30,
        keccak256(abi.encode("order", i)),
        0,
        DrawLegKind.FIXED
      );
    }

    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.BudgetExceeded.selector,
        sponsor,
        address(tokenIn),
        30,
        0
      )
    );
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256(abi.encode("order", uint256(3))),
      0,
      DrawLegKind.FIXED
    );
    vm.stopPrank();

    assertEq(pool.balances(sponsor, address(tokenIn)), 910);
  }

  function test_reconfiguringConfigRefillsBudget() public {
    // A drained budget is not a permanent cap: only the account can re-sign a
    // fresh config, and doing so refills the budget. This is sponsor-owned by
    // design, so the security model must not assume budget is monotonic
    _deposit(sponsor, 1_000);
    _configureSponsor(50, 30, 0);

    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      30,
      keccak256("request-1"),
      0,
      DrawLegKind.FIXED
    );

    // Budget exhausted; the account re-signs with a fresh budget
    vm.prank(sponsor);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: 40,
        authorizer: authorizer,
        expiry: 0
      })
    );

    vm.prank(resolver);
    _debit(
      sponsor,
      address(tokenIn),
      40,
      keccak256("request-2"),
      0,
      DrawLegKind.FIXED
    );

    assertEq(pool.balances(sponsor, address(tokenIn)), 930);
  }

  // Adversarial: per-account isolation (DEC-1675)

  function test_drawRecordsAreScopedPerAccountForSameRequest() public {
    // One order draws two accounts: consuming the record for the first must
    // not consume it for the second, and re-drawing either within the same
    // order is refused
    _deposit(sponsor, 100);
    _deposit(withdrawer, 100);
    _configureSponsor(50, type(uint256).max, 0);
    vm.startPrank(withdrawer);
    pool.setSponsorshipResolver(resolver, true);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
        perOrderCap: 50,
        budget: type(uint256).max,
        authorizer: authorizer,
        expiry: 0
      })
    );
    vm.stopPrank();
    bytes32 requestHash = keccak256("shared-order");

    vm.startPrank(resolver);
    _debit(sponsor, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);
    // The second account is independently drawable for the same order and leg
    _debit(withdrawer, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);

    // Neither account's leg can be drawn a second time for this order
    vm.expectRevert(
      abi.encodeWithSelector(
        RelayFundingPool.AlreadyDrawn.selector,
        requestHash,
        sponsor,
        0
      )
    );
    _debit(sponsor, address(tokenIn), 10, requestHash, 0, DrawLegKind.FIXED);
    vm.stopPrank();

    assertTrue(pool.drawRecords(_order(requestHash), sponsor, 0));
    assertTrue(pool.drawRecords(_order(requestHash), withdrawer, 0));
  }

  function test_withdrawalNoncesAreScopedPerAccount() public {
    // Two accounts reusing the same nonce value do not collide: the nonce is
    // namespaced by account, so one sponsor's withdrawal cannot burn another's
    (address otherSponsor, uint256 otherSponsorPk) = makeAddrAndKey(
      "otherSponsor"
    );
    _deposit(sponsor, 100);
    _deposit(otherSponsor, 100);

    PoolWithdrawal memory first = _withdrawal(30, 1);
    PoolWithdrawal memory second = _withdrawal(40, 1);
    second.account = otherSponsor;

    vm.startPrank(relayer);
    pool.withdraw(first, _signWithdrawal(first, sponsorPk));
    // Same nonce (1), different account — must succeed
    pool.withdraw(second, _signWithdrawal(second, otherSponsorPk));
    vm.stopPrank();

    assertTrue(pool.usedWithdrawalNonces(sponsor, 1));
    assertTrue(pool.usedWithdrawalNonces(otherSponsor, 1));
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

  function _configureSponsor(
    uint256 perOrderCap,
    uint256 budget,
    uint64 expiry
  ) internal {
    vm.startPrank(sponsor);
    pool.setSponsorshipResolver(resolver, true);
    pool.setSponsorshipConfig(
      address(tokenIn),
      SponsorshipConfig({
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
  ///         sponsor's configured authorizer, so tests exercising the other
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
        legIndex: legIndex,
        kind: kind
      }),
      authorization
    );
  }

  function _signDrawAuthorization(
    address account,
    address orderAddress,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(DRAW_AUTHORIZATION_TYPEHASH, account, orderAddress)
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }

  function _withdrawal(
    uint256 amount,
    uint256 nonce
  ) internal view returns (PoolWithdrawal memory withdrawal) {
    withdrawal = PoolWithdrawal({
      account: sponsor,
      token: address(tokenIn),
      amount: amount,
      recipient: recipient,
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
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

  function _configUpdate(
    uint256 perOrderCap,
    uint256 nonce
  ) internal view returns (SponsorshipConfigUpdate memory update) {
    update = SponsorshipConfigUpdate({
      account: sponsor,
      token: address(tokenIn),
      authorizer: authorizer,
      perOrderCap: perOrderCap,
      budget: 200,
      expiry: 0,
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _resolverUpdate(
    bool allowed,
    uint256 nonce
  ) internal view returns (SponsorshipResolverUpdate memory update) {
    update = SponsorshipResolverUpdate({
      account: sponsor,
      resolver: resolver,
      allowed: allowed,
      nonce: nonce,
      deadline: block.timestamp + 1 hours
    });
  }

  function _signConfigUpdate(
    SponsorshipConfigUpdate memory update,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        SPONSORSHIP_CONFIG_UPDATE_TYPEHASH,
        update.account,
        update.token,
        update.authorizer,
        update.perOrderCap,
        update.budget,
        update.expiry,
        update.nonce,
        update.deadline
      )
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }

  function _signResolverUpdate(
    SponsorshipResolverUpdate memory update,
    uint256 signerPk
  ) internal view returns (bytes memory signature) {
    bytes32 structHash = keccak256(
      abi.encode(
        SPONSORSHIP_RESOLVER_UPDATE_TYPEHASH,
        update.account,
        update.resolver,
        update.allowed,
        update.nonce,
        update.deadline
      )
    );
    signature = Eip712.sign(signerPk, poolDomain, structHash);
  }
}
