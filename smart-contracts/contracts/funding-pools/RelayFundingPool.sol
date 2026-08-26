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
  IRelayFundingPool,
  PoolWithdrawal,
  SponsorshipConfig,
  SponsorshipConfigUpdate,
  SponsorshipResolverUpdate
} from "./IRelayFundingPool.sol";

/// @title RelayFundingPool
/// @author Relay Protocol
/// @notice Independently deployed pool that authorizes bounded ERC-20 funding for Relay orders
/// @dev Custody is attributed per account: every token in the pool is either
///      credited to an account balance or an unattributed direct transfer.
///      Neither withdrawal path below can reach another account's balance.
///      `debit` spends an account balance within that account's standing
///      sponsorship config, at most once per
///      `(orderAddress, account, legIndex)` with the per-order cap bounding the
///      sum of the account's legs in the order.
///
///      Two authorizations gate every draw, and the pool checks both itself:
///      the account's standing config sets *how much* it will fund, and its
///      named `authorizer` states per order *which orders* may draw it. The
///      second cannot come from the oracle — the oracle attests facts about a
///      deposit, and whether an order belongs to an account's integration is
///      not one of them — nor from the resolver payload, which its own author
///      controls. Every sponsor-facing guarantee here (balance, cap, budget,
///      expiry, resolver allowlist, per-order authorization, account-only
///      withdrawal) is therefore enforced by this contract alone and does not
///      depend on the oracle or on resolver honesty.
contract RelayFundingPool is
  IRelayFundingPool,
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

  /// @notice EIP-712 type hash for SponsorshipConfigUpdate
  bytes32 public constant SPONSORSHIP_CONFIG_UPDATE_TYPEHASH =
    keccak256(
      "SponsorshipConfigUpdate(address account,address token,address authorizer,uint256 perOrderCap,uint256 budget,uint64 expiry,uint256 nonce,uint256 deadline)"
    );

  /// @notice EIP-712 type hash for DrawAuthorization
  bytes32 public constant DRAW_AUTHORIZATION_TYPEHASH =
    keccak256("DrawAuthorization(address account,address orderAddress)");

  /// @notice EIP-712 type hash for SponsorshipResolverUpdate
  bytes32 public constant SPONSORSHIP_RESOLVER_UPDATE_TYPEHASH =
    keccak256(
      "SponsorshipResolverUpdate(address account,address resolver,bool allowed,uint256 nonce,uint256 deadline)"
    );

  // Fields

  /// @inheritdoc IRelayFundingPool
  mapping(address account => mapping(address token => uint256 balance))
    public balances;

  /// @notice Tracks consumed withdrawal nonces for each account
  mapping(address account => mapping(uint256 nonce => bool used))
    public usedWithdrawalNonces;

  /// @notice Tracks consumed sponsorship update nonces for each account,
  ///         shared between config and resolver updates
  mapping(address account => mapping(uint256 nonce => bool used))
    public usedSponsorshipNonces;

  /// @inheritdoc IRelayFundingPool
  mapping(address account => mapping(address token => SponsorshipConfig))
    public sponsorshipConfig;

  /// @inheritdoc IRelayFundingPool
  mapping(address account => mapping(address resolver => bool allowed))
    public sponsorshipResolvers;

  /// @inheritdoc IRelayFundingPool
  /// @dev Keyed on the order address rather than the attestation digest. The
  ///      digest commits to the resolver payload, so one order can be attested
  ///      any number of times with different payloads — keying on it would
  ///      re-arm the per-order cap on every fresh attestation. The order
  ///      address is the executor's own per-order identity (it gates
  ///      `feesChargedByOrderAddress` the same way) and is part of the signed
  ///      request, so it cannot be varied for a given order.
  mapping(address orderAddress => mapping(address account => mapping(uint256 legIndex => bool drawn)))
    public drawRecords;

  /// @inheritdoc IRelayFundingPool
  /// @dev Keyed on the order address for the same reason as `drawRecords`.
  mapping(address orderAddress => mapping(address account => mapping(address token => uint256 drawn)))
    public orderDraws;

  // Events

  /// @notice Emitted when a deposit is attributed to an account balance
  event Deposited(
    address indexed account,
    address indexed token,
    address indexed funder,
    uint256 amount
  );

  /// @notice Emitted when a resolver returns tokens to an account balance
  /// @dev Keyed by the order and tagged with the leg kind, so unspent-draw
  ///      refunds and exact-output surplus are attributable per order
  event Credited(
    bytes32 indexed requestHash,
    address indexed account,
    address indexed token,
    address resolver,
    DrawLegKind kind,
    uint256 amount
  );

  /// @notice Emitted when an account balance is withdrawn from the pool
  event Withdrawn(
    address indexed account,
    address indexed recipient,
    address indexed token,
    uint256 amount
  );

  /// @notice Emitted when an account sets its draw guardrails for a token
  event SponsorshipConfigSet(
    address indexed account,
    address indexed token,
    address authorizer,
    uint256 perOrderCap,
    uint256 budget,
    uint64 expiry
  );

  /// @notice Emitted when an account allows or disallows a draw resolver
  event SponsorshipResolverSet(
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
  error SponsorshipUpdateExpired(uint256 deadline);
  error SponsorshipNonceUsed(address account, uint256 nonce);
  error InvalidSponsorshipUpdate(address account);
  error ResolverNotAllowed(address account, address resolver);
  error AlreadyDrawn(address orderAddress, address account, uint256 legIndex);
  error SponsorshipConfigExpired(address account, address token, uint64 expiry);
  error NoAuthorizer(address account, address token);
  error InvalidDrawAuthorization(
    address account,
    address authorizer,
    address orderAddress
  );
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
  ) EIP712("RelayFundingPool", "1") {
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

  /// @inheritdoc IRelayFundingPool
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

  /// @inheritdoc IRelayFundingPool
  /// @dev Symmetric with `debit`: pulls tokens back from the calling resolver
  ///      and re-attributes them, used for unspent draws and swap surplus.
  ///      `requestHash` and `kind` are event metadata for per-order
  ///      attribution; the pool does not validate them.
  function credit(
    address account,
    address token,
    uint256 amount,
    bytes32 requestHash,
    DrawLegKind kind
  ) external override onlyRole(RESOLVER_ROLE) whenNotPaused nonReentrant {
    _requireAddress(account);
    uint256 received = _receive(token, amount);
    balances[account][token] += received;
    emit Credited(requestHash, account, token, msg.sender, kind, received);
  }

  /// @inheritdoc IRelayFundingPool
  /// @dev The caller configures its own account. Deliberately not paused so an
  ///      account can always tighten or revoke its guardrails.
  function setSponsorshipConfig(
    address token,
    SponsorshipConfig calldata config
  ) external override {
    _setSponsorshipConfig(msg.sender, token, config);
  }

  /// @inheritdoc IRelayFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for the config of
  ///      wallets that never transact on this chain. Deliberately not paused
  ///      so an account can always tighten or revoke its guardrails.
  function setSponsorshipConfig(
    SponsorshipConfigUpdate calldata update,
    bytes calldata signature
  ) external override {
    _requireAddress(update.account);
    _useSponsorshipNonce(update.account, update.nonce, update.deadline);

    bytes32 digest = _hashSponsorshipConfigUpdate(update);
    if (!update.account.isValidSignatureNow(digest, signature)) {
      revert InvalidSponsorshipUpdate(update.account);
    }

    _setSponsorshipConfig(
      update.account,
      update.token,
      SponsorshipConfig({
        perOrderCap: update.perOrderCap,
        budget: update.budget,
        authorizer: update.authorizer,
        expiry: update.expiry
      })
    );
  }

  /// @inheritdoc IRelayFundingPool
  /// @dev The caller configures its own account. Deliberately not paused so an
  ///      account can always revoke a resolver.
  function setSponsorshipResolver(
    address resolver,
    bool allowed
  ) external override {
    _setSponsorshipResolver(msg.sender, resolver, allowed);
  }

  /// @inheritdoc IRelayFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for the allowlist
  ///      of wallets that never transact on this chain. Deliberately not
  ///      paused so an account can always revoke a resolver.
  function setSponsorshipResolver(
    SponsorshipResolverUpdate calldata update,
    bytes calldata signature
  ) external override {
    _requireAddress(update.account);
    _useSponsorshipNonce(update.account, update.nonce, update.deadline);

    bytes32 digest = _hashSponsorshipResolverUpdate(update);
    if (!update.account.isValidSignatureNow(digest, signature)) {
      revert InvalidSponsorshipUpdate(update.account);
    }

    _setSponsorshipResolver(update.account, update.resolver, update.allowed);
  }

  /// @inheritdoc IRelayFundingPool
  /// @dev The config-gated draw path. Every check is made here rather than in
  ///      the calling resolver, so none of them rests on resolver honesty:
  ///      the caller must hold `RESOLVER_ROLE` and be allowlisted by the
  ///      account, `authorization` must carry the account's authorizer signing
  ///      off on this specific order, each
  ///      `(orderAddress, account, legIndex)` triple funds at most one draw so
  ///      re-executing a leg can never double-draw an account, and the
  ///      per-order cap bounds the sum the account's legs draw of the token
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

    if (!sponsorshipResolvers[draw.account][msg.sender]) {
      revert ResolverNotAllowed(draw.account, msg.sender);
    }
    if (drawRecords[draw.orderAddress][draw.account][draw.legIndex]) {
      revert AlreadyDrawn(draw.orderAddress, draw.account, draw.legIndex);
    }

    SponsorshipConfig storage config = sponsorshipConfig[draw.account][
      draw.token
    ];
    if (config.expiry != 0 && block.timestamp > config.expiry) {
      revert SponsorshipConfigExpired(draw.account, draw.token, config.expiry);
    }
    _requireDrawAuthorization(
      config.authorizer,
      draw.account,
      draw.token,
      draw.orderAddress,
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

  /// @inheritdoc IRelayFundingPool
  /// @dev Callable by anyone carrying a valid account-signed message (ERC-1271
  ///      supported), so the platform can relay and pay gas for sponsor
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

  /// @inheritdoc IRelayFundingPool
  function hashWithdrawal(
    PoolWithdrawal calldata withdrawal
  ) external view override returns (bytes32 digest) {
    digest = _hashWithdrawal(withdrawal);
  }

  /// @inheritdoc IRelayFundingPool
  function hashSponsorshipConfigUpdate(
    SponsorshipConfigUpdate calldata update
  ) external view override returns (bytes32 digest) {
    digest = _hashSponsorshipConfigUpdate(update);
  }

  /// @inheritdoc IRelayFundingPool
  function hashSponsorshipResolverUpdate(
    SponsorshipResolverUpdate calldata update
  ) external view override returns (bytes32 digest) {
    digest = _hashSponsorshipResolverUpdate(update);
  }

  /// @inheritdoc IRelayFundingPool
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
    _requireAddress(token);
    _requireAmount(amount);

    uint256 before = IERC20(token).balanceOf(address(this));
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
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
  function _setSponsorshipConfig(
    address account,
    address token,
    SponsorshipConfig memory config
  ) internal {
    _requireAddress(token);
    sponsorshipConfig[account][token] = config;
    emit SponsorshipConfigSet(
      account,
      token,
      config.authorizer,
      config.perOrderCap,
      config.budget,
      config.expiry
    );
  }

  /// @notice Requires the account's authorizer to have signed off on the order
  /// @dev Fails closed on an unset authorizer: an account that never named one
  ///      cannot be drawn at all, regardless of its cap or balance. ERC-1271 is
  ///      supported, so the authorizer may be a contract wallet.
  function _requireDrawAuthorization(
    address authorizer,
    address account,
    address token,
    address orderAddress,
    bytes calldata authorization
  ) internal view {
    if (authorizer == address(0)) {
      revert NoAuthorizer(account, token);
    }

    bytes32 digest = _hashDrawAuthorization(
      DrawAuthorization({account: account, orderAddress: orderAddress})
    );
    if (!authorizer.isValidSignatureNow(digest, authorization)) {
      revert InvalidDrawAuthorization(account, authorizer, orderAddress);
    }
  }

  /// @notice Stores an account's resolver allowlist entry and emits
  function _setSponsorshipResolver(
    address account,
    address resolver,
    bool allowed
  ) internal {
    _requireAddress(resolver);
    sponsorshipResolvers[account][resolver] = allowed;
    emit SponsorshipResolverSet(account, resolver, allowed);
  }

  /// @notice Validates and consumes a sponsorship update nonce
  function _useSponsorshipNonce(
    address account,
    uint256 nonce,
    uint256 deadline
  ) internal {
    if (block.timestamp > deadline) {
      revert SponsorshipUpdateExpired(deadline);
    }
    if (usedSponsorshipNonces[account][nonce]) {
      revert SponsorshipNonceUsed(account, nonce);
    }
    usedSponsorshipNonces[account][nonce] = true;
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

  /// @notice Computes the EIP-712 digest for a sponsorship config update
  /// @return digest EIP-712 config update digest
  function _hashSponsorshipConfigUpdate(
    SponsorshipConfigUpdate calldata update
  ) internal view returns (bytes32 digest) {
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
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 digest for a per-order draw authorization
  /// @return digest EIP-712 draw authorization digest
  function _hashDrawAuthorization(
    DrawAuthorization memory authorization
  ) internal view returns (bytes32 digest) {
    bytes32 structHash = keccak256(
      abi.encode(
        DRAW_AUTHORIZATION_TYPEHASH,
        authorization.account,
        authorization.orderAddress
      )
    );
    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 digest for a sponsorship resolver update
  /// @return digest EIP-712 resolver update digest
  function _hashSponsorshipResolverUpdate(
    SponsorshipResolverUpdate calldata update
  ) internal view returns (bytes32 digest) {
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
