// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {
  DrawAuthorization,
  DrawLegKind,
  DrawRequest,
  IFundingPool,
  PoolWithdrawal,
  DrawConfig,
  DrawConfigUpdate,
  DrawResolverUpdate,
  DrawRevocation
} from "./IFundingPool.sol";

/// @title IHubErc20View
/// @author Relay Protocol
/// @notice The Hub and token ID behind a Hub ERC-20 view
interface IHubErc20View {
  /// @notice Returns the Hub the view represents a balance of
  /// @return Hub address
  function hub() external view returns (address);

  /// @notice Returns the Hub token ID the view represents
  /// @return Hub token ID
  function tokenId() external view returns (uint256);
}

/// @title IHubPermit
/// @author Relay Protocol
/// @notice The Hub's EIP-712 permit, setting an allowance on a token ID
interface IHubPermit {
  /// @notice Sets `spender`'s allowance on `owner`'s `tokenId` balance by signature
  function permit(
    address owner,
    address spender,
    uint256 tokenId,
    uint256 value,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external;
}

/// @title FundingPool
/// @author Relay Protocol
/// @notice Independently deployed pool that authorizes bounded ERC-20 funding for Relay orders
/// @dev Custody is attributed per account: every token in the pool is either
///      credited to an account balance or an unattributed direct transfer.
///      Neither withdrawal path below can reach another account's balance.
///      `debit` spends an account balance within that account's standing
///      draw config, at most once per
///      `(orderAddress, account, legIndex)` with the per-order cap bounding the
///      account's outstanding net draw for the order.
///
///      Two authorizations gate every draw, and the pool checks both itself:
///      the account's standing config sets *how much* it will fund, and its
///      named `authorizer` states per order *which orders* may draw it and
///      *through which plan*. The second cannot come from the oracle — the
///      oracle attests facts about a deposit, and whether an order belongs to
///      an account's integration is not one of them — nor from the resolver
///      payload, which its own author controls. Every account-facing
///      guarantee here (balance, cap, budget, expiry, resolver allowlist,
///      order and plan authorization, account-only withdrawal) is therefore
///      enforced by this contract alone and does not depend on the oracle.
///      The pool does rely on RESOLVER_ROLE holders for the contents of a
///      `DrawRequest`, plan hash included, exactly as it already does for the
///      amount, order and leg index; a resolver holds that role because it
///      verifies the oracle-signed request commits to the same plan bytes.
contract FundingPool is
  IFundingPool,
  AccessControl,
  EIP712,
  Pausable,
  ReentrancyGuard
{
  using SafeERC20 for IERC20;
  using SignatureChecker for address;

  // Roles

  /// @notice Manages roles and the pool pause state
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Withdraws from its own account balance without a signed message
  bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

  /// @notice Executes config-gated draws and records order-linked credits
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  // Constants

  /// @notice EIP-712 type hash for PoolWithdrawal
  bytes32 public constant POOL_WITHDRAWAL_TYPEHASH =
    keccak256(
      "PoolWithdrawal(address account,address token,uint256 amount,address recipient,uint256 nonce,uint256 deadline)"
    );

  /// @notice EIP-712 type hash for DrawConfigUpdate
  bytes32 public constant DRAW_CONFIG_UPDATE_TYPEHASH =
    keccak256(
      "DrawConfigUpdate(address account,address token,address authorizer,uint256 perOrderCap,uint256 budget,uint64 expiry,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

  /// @notice EIP-712 type hash for DrawAuthorization
  bytes32 public constant DRAW_AUTHORIZATION_TYPEHASH =
    keccak256(
      "DrawAuthorization(address account,address orderAddress,bytes32 planHash,uint256 nonce,uint256 deadline)"
    );

  /// @notice EIP-712 type hash for DrawResolverUpdate
  bytes32 public constant DRAW_RESOLVER_UPDATE_TYPEHASH =
    keccak256(
      "DrawResolverUpdate(address account,address resolver,bool allowed,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

  /// @notice EIP-712 type hash for account-signed revocations
  bytes32 public constant DRAW_REVOCATION_TYPEHASH =
    keccak256(
      "DrawRevocation(address account,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

  /// @notice Smallest step a revocation may move an account's draw nonce
  /// @dev Rules out the `+1` an authorizer can always pre-sign for. It does
  ///      not make the landing value unguessable on its own: the account
  ///      must still pick the jump at random within the bounds
  uint256 public constant MIN_DRAW_NONCE_JUMP = 1 << 32;

  /// @notice Largest step a revocation may move an account's draw nonce
  /// @dev Wide enough that an authorizer cannot pre-sign the landing value,
  ///      small enough that the counter can never be parked near its maximum
  uint256 public constant MAX_DRAW_NONCE_JUMP = type(uint64).max;

  // Fields

  /// @inheritdoc IFundingPool
  mapping(address account => mapping(address token => uint256 balance))
    public balances;

  /// @notice Tracks consumed withdrawal nonces for each account
  mapping(address account => mapping(uint256 nonce => bool used))
    public usedWithdrawalNonces;

  /// @inheritdoc IFundingPool
  /// @dev Doubles as the account's draw-authorization epoch: every config or
  ///      allowlist change moves it, so the authorizer's outstanding draw
  ///      signatures never outlive the guardrails they were signed under
  mapping(address account => uint256 nonce) public override drawNonces;

  /// @inheritdoc IFundingPool
  mapping(address account => mapping(address token => DrawConfig))
    public drawConfig;

  /// @notice Distinguishes each stored budget config for one account and token
  mapping(address account => mapping(address token => uint256 version))
    internal drawConfigVersions;

  /// @inheritdoc IFundingPool
  mapping(address account => mapping(address resolver => bool allowed))
    public drawResolvers;

  /// @inheritdoc IFundingPool
  /// @dev Keyed on the order address rather than the attestation digest. The
  ///      digest commits to the resolver payload, so one order can be attested
  ///      any number of times with different payloads — keying on it would
  ///      re-arm the per-order cap on every fresh attestation. The order
  ///      address is the executor's own per-order identity (it gates
  ///      `feesChargedByOrderAddress` the same way) and is part of the signed
  ///      request, so it cannot be varied for a given order.
  mapping(address orderAddress => mapping(address account => mapping(uint256 legIndex => bool drawn)))
    public drawRecords;

  /// @inheritdoc IFundingPool
  /// @dev Keyed on the order address for the same reason as `drawRecords`.
  mapping(address orderAddress => mapping(address account => mapping(address token => uint256 drawn)))
    public orderDraws;

  /// @notice Provenance of one leg's draw: what it still has outstanding, the
  ///         config version that funded it and how much finite budget it took
  struct LegDraw {
    uint256 version;
    uint256 outstanding;
    uint256 budgeted;
  }

  /// @notice Tracks each leg's draw, so a refund is bounded by its own leg
  /// @dev A refund lowers the order's net draw by at most what the named leg
  ///      still has outstanding, and restores only the budget that leg took,
  ///      while the config that funded it is still in force. Tokens beyond
  ///      the leg's draw are a plain balance credit.
  mapping(address orderAddress => mapping(address account => mapping(address token => mapping(uint256 legIndex => LegDraw))))
    internal legDraws;

  /// @inheritdoc IFundingPool
  mapping(address account => uint256 epoch) public override configEpoch;

  // Events

  /// @notice Emitted when a deposit is attributed to an account balance
  event Deposited(
    address indexed account,
    address indexed token,
    address indexed funder,
    uint256 amount
  );

  /// @notice Emitted when a resolver returns tokens to an account balance
  /// @dev Order-linked credits name the leg they refund and report restored
  ///      capacity; surplus credits use a zero order address and report zero
  ///      restoration
  event Credited(
    address indexed orderAddress,
    address indexed account,
    address indexed token,
    bytes32 requestHash,
    address resolver,
    DrawLegKind kind,
    uint256 legIndex,
    uint256 amount,
    uint256 restored,
    uint256 budgetRestored
  );

  /// @notice Emitted when an account balance is withdrawn from the pool
  event Withdrawn(
    address indexed account,
    address indexed recipient,
    address indexed token,
    uint256 amount
  );

  /// @notice Emitted when an account sets its draw guardrails for a token
  event DrawConfigSet(
    address indexed account,
    address indexed token,
    address authorizer,
    uint256 perOrderCap,
    uint256 budget,
    uint64 expiry
  );

  /// @notice Emitted whenever an account's draw nonce advances, which
  ///         invalidates every draw authorization signed against a lower one
  event DrawNonceAdvanced(address indexed account, uint256 nonce);

  /// @notice Emitted when an account allows or disallows a draw resolver
  event DrawResolverSet(
    address indexed account,
    address indexed resolver,
    bool allowed
  );

  /// @notice Emitted when a resolver draws an account balance for an order
  /// @dev Indexed on the order address, which is what the draw records and the
  ///      per-order cap are keyed on. The attestation digest that drove the
  ///      settlement rides along as data, so a draw stays traceable to its
  ///      execution as well as to its order
  event Drawn(
    address indexed orderAddress,
    address indexed account,
    address indexed token,
    bytes32 requestHash,
    address resolver,
    DrawLegKind kind,
    uint256 legIndex,
    uint256 amount
  );

  /// @notice Invalidates queued signed updates from the account's previous epoch
  event DrawConfigEpochAdvanced(address indexed account, uint256 epoch);

  /// @notice Emitted when an account burns a withdrawal nonce unused
  event WithdrawalNonceCancelled(address indexed account, uint256 nonce);

  // Errors

  error ZeroAddress();
  error ZeroAmount();
  error InsufficientBalance(
    address account,
    address token,
    uint256 amount,
    uint256 balance
  );
  error WithdrawalExpired(uint256 deadline);
  error WithdrawalNonceUsed(address account, uint256 nonce);
  error InvalidWithdrawal(address account);
  error DrawConfigUpdateExpired(uint256 deadline);
  error DrawConfigEpochMismatch(
    address account,
    uint256 expected,
    uint256 actual
  );
  error DrawNonceMismatch(address account, uint256 expected, uint256 actual);
  error InvalidDrawConfigUpdate(address account);
  error InvalidRevocationNonce(address account, uint256 current, uint256 nonce);
  error ResolverNotAllowed(address account, address resolver);
  error AlreadyDrawn(address orderAddress, address account, uint256 legIndex);
  error DrawConfigExpired(address account, address token, uint64 expiry);
  error NoAuthorizer(address account, address token);
  error InvalidDrawAuthorization(
    address account,
    address authorizer,
    address orderAddress
  );
  error DrawAuthorizationPlanMismatch(bytes32 expected, bytes32 actual);
  error DrawAuthorizationNonceMismatch(uint256 expected, uint256 actual);
  error DrawAuthorizationExpired(uint256 deadline);
  error PerOrderCapExceeded(
    address account,
    address token,
    uint256 orderTotal,
    uint256 cap
  );
  error BudgetExceeded(
    address account,
    address token,
    uint256 amount,
    uint256 budget
  );

  // Constructor

  /// @notice Creates a standalone funding pool with its initial role members
  constructor(
    address admin,
    address withdrawer,
    address resolver
  ) EIP712("FundingPool", "1") {
    _requireAddress(admin);
    _requireAddress(withdrawer);
    _requireAddress(resolver);

    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(WITHDRAWER_ROLE, ADMIN_ROLE);
    _setRoleAdmin(RESOLVER_ROLE, ADMIN_ROLE);

    _grantRole(ADMIN_ROLE, admin);
    _grantRole(WITHDRAWER_ROLE, withdrawer);
    _grantRole(RESOLVER_ROLE, resolver);
  }

  // Public methods

  /// @inheritdoc IFundingPool
  /// @dev Permissionless: anyone may top up any account. The credited amount
  ///      is the balance the pool actually received, so fee-on-transfer tokens
  ///      cannot inflate an account balance beyond the pool's holdings.
  function depositFor(
    address account,
    address token,
    uint256 amount
  ) external override whenNotPaused nonReentrant {
    _requireAddress(account);
    uint256 received = _receive(token, amount);
    balances[account][token] += received;
    emit Deposited(account, token, msg.sender, received);
  }

  /// @inheritdoc IFundingPool
  /// @dev Relayable by anyone: the account signs the Hub permit and never has
  ///      to send a transaction itself. The permit must succeed, so the
  ///      account's signature is what authorizes the pull every time; a
  ///      standing allowance never substitutes for it. A permit already
  ///      consumed, by a relay retried after it landed or by a front-run
  ///      straight to the Hub, reverts, and the relayer signs a fresh one.
  ///      Hub ERC-20 views only: the token must name its Hub and token ID.
  function depositFromWithPermit(
    address account,
    address token,
    uint256 amount,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external override whenNotPaused nonReentrant {
    _requireAddress(account);
    _requireAddress(token);
    _requireAmount(amount);

    IHubErc20View hubView = IHubErc20View(token);
    IHubPermit(hubView.hub()).permit(
      account,
      address(this),
      hubView.tokenId(),
      amount,
      deadline,
      v,
      r,
      s
    );

    uint256 received = _receiveFrom(account, token, amount);
    balances[account][token] += received;
    emit Deposited(account, token, account, received);
  }

  /// @inheritdoc IFundingPool
  /// @dev Pulls tokens back from the calling resolver and re-attributes them.
  ///      Order-linked credits lower that order's outstanding draw by at most
  ///      what the named leg still has outstanding, and give back the finite
  ///      budget that leg's draw took, provided the config that funded it is
  ///      still in force. Anything beyond the leg's draw, and surplus credits
  ///      with a zero order address, affect only the balance.
  function credit(
    address account,
    address token,
    uint256 amount,
    address orderAddress,
    uint256 legIndex,
    bytes32 requestHash,
    DrawLegKind kind
  ) external override onlyRole(RESOLVER_ROLE) whenNotPaused nonReentrant {
    _requireAddress(account);
    uint256 received = _receive(token, amount);
    balances[account][token] += received;

    LegDraw storage leg = legDraws[orderAddress][account][token][legIndex];
    uint256 restored = received < leg.outstanding ? received : leg.outstanding;
    uint256 budgetRestored;
    if (restored != 0) {
      leg.outstanding -= restored;
      orderDraws[orderAddress][account][token] -= restored;
      budgetRestored = _restoreBudget(account, token, leg, restored);
    }
    emit Credited(
      orderAddress,
      account,
      token,
      requestHash,
      msg.sender,
      kind,
      legIndex,
      received,
      restored,
      budgetRestored
    );
  }

  /// @inheritdoc IFundingPool
  /// @dev The caller configures its own account. Deliberately not paused so an
  ///      account can always tighten or revoke its guardrails.
  function setDrawConfig(
    address token,
    DrawConfig calldata config
  ) external override {
    _advanceConfigEpoch(msg.sender);
    _advanceDrawNonce(msg.sender, drawNonces[msg.sender] + 1);
    _setDrawConfig(msg.sender, token, config);
  }

  /// @inheritdoc IFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for the config of
  ///      wallets that never transact on this chain. Deliberately not paused
  ///      so an account can always tighten or revoke its guardrails.
  function setDrawConfig(
    DrawConfigUpdate calldata update,
    bytes calldata signature
  ) external override {
    _requireAddress(update.account);
    _useDrawNonce(update.account, update.epoch, update.nonce, update.deadline);

    bytes32 digest = _hashDrawConfigUpdate(update);
    if (!update.account.isValidSignatureNow(digest, signature)) {
      revert InvalidDrawConfigUpdate(update.account);
    }

    _setDrawConfig(
      update.account,
      update.token,
      DrawConfig({
        perOrderCap: update.perOrderCap,
        budget: update.budget,
        authorizer: update.authorizer,
        expiry: update.expiry
      })
    );
  }

  /// @inheritdoc IFundingPool
  /// @dev The caller configures its own account. Deliberately not paused so an
  ///      account can always revoke a resolver.
  function setDrawResolver(address resolver, bool allowed) external override {
    _advanceConfigEpoch(msg.sender);
    _advanceDrawNonce(msg.sender, drawNonces[msg.sender] + 1);
    _setDrawResolver(msg.sender, resolver, allowed);
  }

  /// @inheritdoc IFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for the allowlist
  ///      of wallets that never transact on this chain. Deliberately not
  ///      paused so an account can always revoke a resolver.
  function setDrawResolver(
    DrawResolverUpdate calldata update,
    bytes calldata signature
  ) external override {
    _requireAddress(update.account);
    _useDrawNonce(update.account, update.epoch, update.nonce, update.deadline);

    bytes32 digest = _hashDrawResolverUpdate(update);
    if (!update.account.isValidSignatureNow(digest, signature)) {
      revert InvalidDrawConfigUpdate(update.account);
    }

    _setDrawResolver(update.account, update.resolver, update.allowed);
  }

  /// @inheritdoc IFundingPool
  /// @dev Lets an account stand down its authorizer's outstanding signatures
  ///      and queued account updates without touching its config. The current
  ///      authorizer remains able to sign new draws under the new nonce.
  ///      `nonce` must be unpredictable: the authorizer may hold signatures
  ///      for any nonce it can guess, so a small or fixed step kills nothing
  ///      pre-signed. Pick it at random within the jump bounds.
  ///      Deliberately not paused so an account can always revoke.
  function revokeDrawAuthorizations(uint256 nonce) external override {
    _advanceConfigEpoch(msg.sender);
    _jumpDrawNonce(msg.sender, nonce);
  }

  /// @inheritdoc IFundingPool
  /// @dev As above, `revocation.nonce` must be picked at random within the
  ///      jump bounds, or the authorizer's pre-signed draws survive it. The
  ///      bounds are measured against the nonce current when this executes,
  ///      not when it was signed: the revocation is valid while
  ///      `MIN_DRAW_NONCE_JUMP <= nonce - drawNonces(account) <=
  ///      MAX_DRAW_NONCE_JUMP`, so queued signed updates that bring the
  ///      remaining gap under the minimum invalidate it and the account
  ///      re-signs. The SDK draws jumps from twice the minimum, which leaves
  ///      2^32 such advances of slack.
  function revokeDrawAuthorizations(
    DrawRevocation calldata revocation,
    bytes calldata signature
  ) external override {
    _requireAddress(revocation.account);
    // Grants can advance the nonce while this signature is pending. Only an
    // epoch change, its deadline or a remaining gap outside the jump bounds
    // may invalidate it.
    if (block.timestamp > revocation.deadline) {
      revert DrawConfigUpdateExpired(revocation.deadline);
    }
    if (revocation.epoch != configEpoch[revocation.account]) {
      revert DrawConfigEpochMismatch(
        revocation.account,
        configEpoch[revocation.account],
        revocation.epoch
      );
    }
    if (
      !revocation.account.isValidSignatureNow(
        _hashDrawRevocation(revocation),
        signature
      )
    ) {
      revert InvalidDrawConfigUpdate(revocation.account);
    }
    _advanceConfigEpoch(revocation.account);
    _jumpDrawNonce(revocation.account, revocation.nonce);
  }

  /// @inheritdoc IFundingPool
  function hashDrawRevocation(
    DrawRevocation calldata revocation
  ) external view override returns (bytes32 digest) {
    digest = _hashDrawRevocation(revocation);
  }

  /// @inheritdoc IFundingPool
  /// @dev The config-gated draw path. Every check is made here rather than in
  ///      the calling resolver, so none of them rests on resolver honesty:
  ///      the caller must hold `RESOLVER_ROLE` and be allowlisted by the
  ///      account, `authorization` must carry the account's authorizer signing
  ///      off on this specific order and plan under the account's current
  ///      draw nonce and before its deadline, each
  ///      `(orderAddress, account, legIndex)` triple funds at most one draw so
  ///      re-executing a leg can never double-draw an account, and the
  ///      per-order cap bounds the account's outstanding net draw of the token
  ///      for the order. A revert anywhere in the outer settlement unwinds the
  ///      draw records with the balances.
  function debit(
    DrawRequest calldata draw,
    bytes calldata authorization
  ) external override onlyRole(RESOLVER_ROLE) whenNotPaused nonReentrant {
    _requireAddress(draw.account);
    _requireAddress(draw.token);
    _requireAddress(draw.orderAddress);
    _requireAmount(draw.amount);

    if (!drawResolvers[draw.account][msg.sender]) {
      revert ResolverNotAllowed(draw.account, msg.sender);
    }
    if (drawRecords[draw.orderAddress][draw.account][draw.legIndex]) {
      revert AlreadyDrawn(draw.orderAddress, draw.account, draw.legIndex);
    }

    DrawConfig storage config = drawConfig[draw.account][draw.token];
    if (config.expiry != 0 && block.timestamp > config.expiry) {
      revert DrawConfigExpired(draw.account, draw.token, config.expiry);
    }
    _requireDrawAuthorization(
      config.authorizer,
      draw.account,
      draw.token,
      draw.orderAddress,
      draw.planHash,
      authorization
    );

    uint256 orderTotal = orderDraws[draw.orderAddress][draw.account][
      draw.token
    ] + draw.amount;
    if (orderTotal > config.perOrderCap) {
      revert PerOrderCapExceeded(
        draw.account,
        draw.token,
        orderTotal,
        config.perOrderCap
      );
    }
    if (config.budget != type(uint256).max) {
      if (draw.amount > config.budget) {
        revert BudgetExceeded(
          draw.account,
          draw.token,
          draw.amount,
          config.budget
        );
      }
      unchecked {
        config.budget -= draw.amount;
      }
    }

    uint256 balance = balances[draw.account][draw.token];
    if (draw.amount > balance) {
      revert InsufficientBalance(
        draw.account,
        draw.token,
        draw.amount,
        balance
      );
    }
    unchecked {
      balances[draw.account][draw.token] = balance - draw.amount;
    }
    drawRecords[draw.orderAddress][draw.account][draw.legIndex] = true;
    orderDraws[draw.orderAddress][draw.account][draw.token] = orderTotal;
    legDraws[draw.orderAddress][draw.account][draw.token][
      draw.legIndex
    ] = LegDraw({
      version: drawConfigVersions[draw.account][draw.token],
      outstanding: draw.amount,
      budgeted: config.budget == type(uint256).max ? 0 : draw.amount
    });

    IERC20(draw.token).safeTransfer(msg.sender, draw.amount);
    emit Drawn(
      draw.orderAddress,
      draw.account,
      draw.token,
      draw.requestHash,
      msg.sender,
      draw.kind,
      draw.legIndex,
      draw.amount
    );
  }

  /// @notice Withdraws from the caller's own account balance
  /// @dev Kept for the platform's account operations; it cannot reach any
  ///      other account's balance. Deliberately not paused so funds can always
  ///      leave the pool.
  function withdraw(
    address token,
    uint256 amount,
    address recipient
  ) external onlyRole(WITHDRAWER_ROLE) nonReentrant {
    _requireAddress(recipient);
    _payOut(msg.sender, token, amount, recipient);
  }

  /// @inheritdoc IFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for account
  ///      withdrawals. Deliberately not paused so funds can always leave the
  ///      pool.
  function withdraw(
    PoolWithdrawal calldata withdrawal,
    bytes calldata signature
  ) external override nonReentrant {
    _requireAddress(withdrawal.account);
    _requireAddress(withdrawal.recipient);
    if (block.timestamp > withdrawal.deadline) {
      revert WithdrawalExpired(withdrawal.deadline);
    }
    if (usedWithdrawalNonces[withdrawal.account][withdrawal.nonce]) {
      revert WithdrawalNonceUsed(withdrawal.account, withdrawal.nonce);
    }

    bytes32 digest = _hashWithdrawal(withdrawal);
    if (!withdrawal.account.isValidSignatureNow(digest, signature)) {
      revert InvalidWithdrawal(withdrawal.account);
    }

    usedWithdrawalNonces[withdrawal.account][withdrawal.nonce] = true;
    _payOut(
      withdrawal.account,
      withdrawal.token,
      withdrawal.amount,
      withdrawal.recipient
    );
  }

  /// @inheritdoc IFundingPool
  /// @dev Lets an account retract a signed withdrawal before anyone relays
  ///      it. Deliberately not paused, like the withdrawal it cancels.
  function cancelWithdrawalNonce(uint256 nonce) external override {
    if (usedWithdrawalNonces[msg.sender][nonce]) {
      revert WithdrawalNonceUsed(msg.sender, nonce);
    }
    usedWithdrawalNonces[msg.sender][nonce] = true;
    emit WithdrawalNonceCancelled(msg.sender, nonce);
  }

  /// @inheritdoc IFundingPool
  function hashWithdrawal(
    PoolWithdrawal calldata withdrawal
  ) external view override returns (bytes32 digest) {
    digest = _hashWithdrawal(withdrawal);
  }

  /// @inheritdoc IFundingPool
  function hashDrawConfigUpdate(
    DrawConfigUpdate calldata update
  ) external view override returns (bytes32 digest) {
    digest = _hashDrawConfigUpdate(update);
  }

  /// @inheritdoc IFundingPool
  function hashDrawResolverUpdate(
    DrawResolverUpdate calldata update
  ) external view override returns (bytes32 digest) {
    digest = _hashDrawResolverUpdate(update);
  }

  /// @inheritdoc IFundingPool
  function hashDrawAuthorization(
    DrawAuthorization calldata authorization
  ) external view override returns (bytes32 digest) {
    digest = _hashDrawAuthorization(authorization);
  }

  /// @notice Pauses pool deposits, credits, and debits; withdrawals stay open
  function pause() external onlyRole(ADMIN_ROLE) {
    _pause();
  }

  /// @notice Resumes pool deposits, credits, and debits
  function unpause() external onlyRole(ADMIN_ROLE) {
    _unpause();
  }

  // Internal methods

  /// @notice Pulls tokens from the caller and returns the amount received
  /// @return received Measured pool balance increase
  function _receive(
    address token,
    uint256 amount
  ) internal returns (uint256 received) {
    received = _receiveFrom(msg.sender, token, amount);
  }

  /// @notice Pulls tokens from `from` and returns the amount received
  /// @return received Measured pool balance increase
  function _receiveFrom(
    address from,
    address token,
    uint256 amount
  ) internal returns (uint256 received) {
    _requireAddress(token);
    _requireAmount(amount);

    uint256 before = IERC20(token).balanceOf(address(this));
    IERC20(token).safeTransferFrom(from, address(this), amount);
    received = IERC20(token).balanceOf(address(this)) - before;
    _requireAmount(received);
  }

  /// @notice Deducts an account balance and transfers the tokens out
  function _payOut(
    address account,
    address token,
    uint256 amount,
    address recipient
  ) internal {
    _requireAddress(token);
    _requireAmount(amount);

    uint256 balance = balances[account][token];
    if (amount > balance) {
      revert InsufficientBalance(account, token, amount, balance);
    }
    unchecked {
      balances[account][token] = balance - amount;
    }

    IERC20(token).safeTransfer(recipient, amount);
    emit Withdrawn(account, recipient, token, amount);
  }

  /// @notice Stores an account's draw guardrails for one token and emits
  /// @dev A zero `authorizer` is accepted and closes the token for draws, so an
  ///      account can revoke its operator without also having to zero the cap.
  function _setDrawConfig(
    address account,
    address token,
    DrawConfig memory config
  ) internal {
    _requireAddress(token);
    ++drawConfigVersions[account][token];
    drawConfig[account][token] = config;
    emit DrawConfigSet(
      account,
      token,
      config.authorizer,
      config.perOrderCap,
      config.budget,
      config.expiry
    );
  }

  /// @notice Requires the account's authorizer to have signed off on the order
  ///         and the exact plan drawing it
  /// @dev `envelope` is `abi.encode(DrawAuthorization, bytes signature)`. The
  ///      signed account and order must be the ones being drawn, the signed
  ///      plan hash must be the one the resolver is executing, the nonce must
  ///      be the account's current draw nonce (so any config change
  ///      since signing voids it) and the deadline must not have passed.
  ///      Fails closed on an unset authorizer: an account that never named one
  ///      cannot be drawn at all, regardless of its cap or balance. ERC-1271 is
  ///      supported, so the authorizer may be a contract wallet.
  function _requireDrawAuthorization(
    address authorizer,
    address account,
    address token,
    address orderAddress,
    bytes32 planHash,
    bytes calldata envelope
  ) internal view {
    if (authorizer == address(0)) {
      revert NoAuthorizer(account, token);
    }

    // Five struct words plus the signature's offset and length: anything
    // shorter cannot decode, and fails as the forgery it is
    if (envelope.length < 224) {
      revert InvalidDrawAuthorization(account, authorizer, orderAddress);
    }
    (DrawAuthorization memory authorization, bytes memory signature) = abi
      .decode(envelope, (DrawAuthorization, bytes));
    if (
      authorization.account != account ||
      authorization.orderAddress != orderAddress
    ) {
      revert InvalidDrawAuthorization(account, authorizer, orderAddress);
    }
    if (authorization.planHash != planHash) {
      revert DrawAuthorizationPlanMismatch(planHash, authorization.planHash);
    }
    uint256 nonce = drawNonces[account];
    if (authorization.nonce != nonce) {
      revert DrawAuthorizationNonceMismatch(nonce, authorization.nonce);
    }
    if (block.timestamp > authorization.deadline) {
      revert DrawAuthorizationExpired(authorization.deadline);
    }

    bytes32 digest = _hashDrawAuthorization(authorization);
    if (!authorizer.isValidSignatureNow(digest, signature)) {
      revert InvalidDrawAuthorization(account, authorizer, orderAddress);
    }
  }

  /// @notice Stores an account's resolver allowlist entry and emits
  function _setDrawResolver(
    address account,
    address resolver,
    bool allowed
  ) internal {
    _requireAddress(resolver);
    drawResolvers[account][resolver] = allowed;
    emit DrawResolverSet(account, resolver, allowed);
  }

  /// @notice Gives a refunded leg's draw back to the finite budget that funded
  ///         it, if that config is still the one in force
  /// @dev The version is the leg's own, recorded at debit time; the current
  ///      version is never consulted to pick which draw a refund restores.
  /// @return budgetRestored Amount returned to the current config's budget
  function _restoreBudget(
    address account,
    address token,
    LegDraw storage leg,
    uint256 restored
  ) internal returns (uint256 budgetRestored) {
    DrawConfig storage config = drawConfig[account][token];
    if (config.budget == type(uint256).max) return 0;
    if (leg.version != drawConfigVersions[account][token]) return 0;

    budgetRestored = restored < leg.budgeted ? restored : leg.budgeted;
    if (budgetRestored == 0) return 0;
    unchecked {
      leg.budgeted -= budgetRestored;
    }
    config.budget += budgetRestored;
  }

  /// @notice Validates the current config epoch and records the next nonce
  /// @dev Ordinary signed updates preserve the epoch so pre-signed batches
  ///      can use consecutive nonces. Direct changes and explicit revocation
  ///      advance the epoch, invalidating every queued old-epoch update even
  ///      when its nonce becomes next. Requiring the next nonce prevents a
  ///      signed update from jumping the counter close to its maximum.
  function _useDrawNonce(
    address account,
    uint256 epoch,
    uint256 nonce,
    uint256 deadline
  ) internal {
    if (block.timestamp > deadline) {
      revert DrawConfigUpdateExpired(deadline);
    }
    if (epoch != configEpoch[account]) {
      revert DrawConfigEpochMismatch(account, configEpoch[account], epoch);
    }
    uint256 expected = drawNonces[account] + 1;
    if (nonce != expected) {
      revert DrawNonceMismatch(account, expected, nonce);
    }
    _advanceDrawNonce(account, nonce);
  }

  /// @notice Records a new draw nonce for an account and emits
  /// @dev Every path that changes an account's guardrails lands here, so the
  ///      event is the single signal that outstanding draw authorizations
  ///      signed against a lower nonce are dead
  function _advanceDrawNonce(address account, uint256 nonce) internal {
    drawNonces[account] = nonce;
    emit DrawNonceAdvanced(account, nonce);
  }

  /// @notice Moves an account's draw nonce to the revocation's
  ///         account-chosen value
  /// @dev A +1 step is predictable, so an authorizer could have pre-signed
  ///      draws for it; a random jump lands where none were signed. The
  ///      minimum refuses the small steps that are always guessable.
  function _jumpDrawNonce(address account, uint256 nonce) internal {
    uint256 current = drawNonces[account];
    if (
      nonce <= current ||
      nonce - current < MIN_DRAW_NONCE_JUMP ||
      nonce - current > MAX_DRAW_NONCE_JUMP
    ) {
      revert InvalidRevocationNonce(account, current, nonce);
    }
    _advanceDrawNonce(account, nonce);
  }

  /// @notice Invalidates every queued update signed in the previous epoch
  function _advanceConfigEpoch(address account) internal {
    emit DrawConfigEpochAdvanced(account, ++configEpoch[account]);
  }

  /// @notice Computes the EIP-712 digest for an account-signed revocation
  /// @return digest EIP-712 revocation digest
  function _hashDrawRevocation(
    DrawRevocation calldata revocation
  ) internal view returns (bytes32 digest) {
    digest = _hashTypedDataV4(
      keccak256(
        abi.encode(
          DRAW_REVOCATION_TYPEHASH,
          revocation.account,
          revocation.epoch,
          revocation.nonce,
          revocation.deadline
        )
      )
    );
  }

  /// @notice Computes the EIP-712 digest for a pool withdrawal
  /// @return digest EIP-712 withdrawal digest
  function _hashWithdrawal(
    PoolWithdrawal calldata withdrawal
  ) internal view returns (bytes32 digest) {
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
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 digest for a draw config update
  /// @return digest EIP-712 config update digest
  function _hashDrawConfigUpdate(
    DrawConfigUpdate calldata update
  ) internal view returns (bytes32 digest) {
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
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 digest for a draw authorization
  /// @return digest EIP-712 draw authorization digest
  function _hashDrawAuthorization(
    DrawAuthorization memory authorization
  ) internal view returns (bytes32 digest) {
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
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 digest for a draw resolver update
  /// @return digest EIP-712 resolver update digest
  function _hashDrawResolverUpdate(
    DrawResolverUpdate calldata update
  ) internal view returns (bytes32 digest) {
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
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Validates a nonzero address
  function _requireAddress(address value) internal pure {
    if (value == address(0)) {
      revert ZeroAddress();
    }
  }

  /// @notice Validates a nonzero amount
  function _requireAmount(uint256 amount) internal pure {
    if (amount == 0) {
      revert ZeroAmount();
    }
  }
}
