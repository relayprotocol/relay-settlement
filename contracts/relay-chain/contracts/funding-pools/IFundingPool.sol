// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Draw-leg settlement modes
/// @dev FIXED legs draw an exact amount unconditionally; SHORTFALL_TO_TARGET
///      legs draw only what is missing to reach a target output holding and
///      return any surplus above the target to the same account. Carried on
///      `Drawn`/`Credited` events so fixed draws and exact-output
///      contributions are attributable on-chain per order
enum DrawLegKind {
  FIXED,
  SHORTFALL_TO_TARGET
}

/// @notice Standing guardrails an account grants over draws of one token
/// @dev The config is a coarse ceiling the operator cannot move: per-order
///      amounts are quote-driven beneath it and every draw must additionally
///      carry a per-order authorization from `authorizer`. A zero
///      `perOrderCap` or a zero `authorizer` (both the default) closes the
///      token for draws entirely.
/// @param perOrderCap Maximum outstanding net draw for one order,
///        bounding the sum of draws minus order-linked credits
/// @param budget Remaining aggregate draw budget; `type(uint256).max` means
///        the budget is unlimited and is not decremented
/// @param authorizer Account whose signature authorizes each order this
///        account funds. Any wallet works (EOA or ERC-1271); the account picks
///        it when signing the config and revokes by re-signing. Canonically
///        the platform's operator key, so the account itself stays offline.
///        Zero closes the token for draws. Its outstanding draw signatures
///        die whenever the account's draw nonce advances (any config
///        or allowlist change, or `revokeDrawAuthorizations`)
/// @param expiry Timestamp after which draws are rejected; zero means never
/// @dev `authorizer` and `expiry` share a slot, so `debit` reads the whole
///      config in three loads rather than four
struct DrawConfig {
  uint256 perOrderCap;
  uint256 budget;
  address authorizer;
  uint64 expiry;
}

/// @notice Authorizer-signed statement that one order may draw an account
///         through one exact execution plan
/// @dev The standing config says *how much* an account will fund; this says
///      *which orders* and *through which plan*. The order predicate is
///      off-chain knowledge (order X came through this account's
///      integration), so it cannot be derived on-chain and cannot be attested
///      by the oracle, which only certifies facts about a deposit. The plan is
///      bound because the oracle attests whatever plan the payload's author
///      commits to: without it, an authorization for a legitimate order could
///      be spent on a plan that routes the drawn funds to the solver
///      (DEC-1955). Travels as `abi.encode(DrawAuthorization, bytes signature)`
/// @param account Pool account the authorization draws from
/// @param orderAddress Order address the draws are authorized for; scopes the
///        authorization to one order, and replay within that order is bounded
///        by the per-order draw records and cap
/// @param planHash `keccak256` of the resolver's committed execution payload,
///        the same bytes the oracle-signed request nonce commits to: every
///        leg, every sandbox call, the surplus recipient and the salt
/// @param nonce The account's `drawNonces` value at signing time. Any
///        config or allowlist change, and `revokeDrawAuthorizations`, moves it
///        and invalidates every outstanding authorization at once; revocation
///        moves it to an account-chosen value, so authorizations pre-signed
///        for future nonces die with it
/// @param deadline Last timestamp (inclusive) at which the authorization may
///        be used; zero is always expired
struct DrawAuthorization {
  address account;
  address orderAddress;
  bytes32 planHash;
  uint256 nonce;
  uint256 deadline;
}

/// @notice One order-scoped draw against an account balance
/// @param account Pool account whose balance funds the draw
/// @param token ERC-20 token drawn from the account balance
/// @param amount Amount of token to draw
/// @param orderAddress Order the draw belongs to; keys the draw records and
///        the per-order cap, so the cap bounds an order rather than a single
///        oracle attestation of it
/// @param requestHash Attestation digest driving the settlement, carried for
///        event attribution only; the pool does not key any record on it
/// @param planHash `keccak256` of the resolver's committed execution payload,
///        which the signed authorization must match. Like every other field
///        it is supplied by the trusted resolver, which has already checked
///        that the oracle-signed request commits to the same bytes
/// @param legIndex Position of the leg in the resolver payload
/// @param kind Settlement mode of the leg
struct DrawRequest {
  address account;
  address token;
  uint256 amount;
  address orderAddress;
  bytes32 requestHash;
  bytes32 planHash;
  uint256 legIndex;
  DrawLegKind kind;
}

/// @notice Account-signed instruction to pay out part of the account's balance
/// @param account Pool account whose balance is withdrawn; must sign the message
/// @param token ERC-20 token to withdraw
/// @param amount Amount of token to withdraw
/// @param recipient Address receiving the withdrawn tokens
/// @param nonce Account-scoped replay-protection nonce
/// @param deadline Timestamp after which the withdrawal is invalid
struct PoolWithdrawal {
  address account;
  address token;
  uint256 amount;
  address recipient;
  uint256 nonce;
  uint256 deadline;
}

/// @notice Account-signed instruction to set the account's draw config
///         for one token, relayable by anyone
/// @param account Pool account whose config is set; must sign the message
/// @param token ERC-20 token the config applies to
/// @param authorizer Account authorizing each order this account funds; zero
///        closes the token for draws
/// @param perOrderCap Maximum outstanding net draw for one order
/// @param budget Remaining aggregate draw budget; `type(uint256).max` means
///        the budget is unlimited and is not decremented
/// @param expiry Timestamp after which draws are rejected; zero means never
/// @param epoch Current configEpoch(account); shared by all updates in a batch
/// @param nonce The account's next draw nonce
///        (`drawNonces(account) + 1`), shared with resolver updates
/// @param deadline Timestamp after which the update is invalid
struct DrawConfigUpdate {
  address account;
  address token;
  address authorizer;
  uint256 perOrderCap;
  uint256 budget;
  uint64 expiry;
  uint256 epoch;
  uint256 nonce;
  uint256 deadline;
}

/// @notice Account-signed instruction to allow or disallow a draw resolver
///         for the account, relayable by anyone
/// @param account Pool account whose allowlist is updated; must sign the message
/// @param resolver Resolver contract the update applies to
/// @param allowed True to allow the resolver to draw from the account
/// @param epoch Current configEpoch(account); shared by all updates in a batch
/// @param nonce The account's next draw nonce
///        (`drawNonces(account) + 1`), shared with config updates
/// @param deadline Timestamp after which the update is invalid
struct DrawResolverUpdate {
  address account;
  address resolver;
  bool allowed;
  uint256 epoch;
  uint256 nonce;
  uint256 deadline;
}

/// @notice Account-signed cancellation of queued updates and outstanding draws
/// @param account Account whose signatures are revoked; must sign the message
/// @param epoch Current configEpoch(account)
/// @param nonce New draw nonce, picked at random between
///        `MIN_DRAW_NONCE_JUMP` and `MAX_DRAW_NONCE_JUMP` above the current
///        one; a predictable value kills nothing the authorizer pre-signed
/// @param deadline Timestamp after which the revocation is invalid
struct DrawRevocation {
  address account;
  uint256 epoch;
  uint256 nonce;
  uint256 deadline;
}

/// @title IFundingPool
/// @author Relay Protocol
/// @notice Interface for independently deployed, role-controlled funding pools
interface IFundingPool {
  /// @notice Returns the pool balance a token holds for an account
  /// @return balance Attributed token balance
  function balances(
    address account,
    address token
  ) external view returns (uint256 balance);

  /// @notice Deposits tokens from the caller into an account's pool balance
  function depositFor(address account, address token, uint256 amount) external;

  /// @notice Deposits a Hub ERC-20 view token from the account itself into its
  ///         pool balance, authorized by the account's Hub permit, so anyone
  ///         can relay the deposit and the account only signs
  function depositFromWithPermit(
    address account,
    address token,
    uint256 amount,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external;

  /// @notice Returns tokens from the calling resolver to an account's
  ///         balance, restoring draw capacity when tied to an order leg
  /// @param orderAddress Order whose outstanding draw is being returned;
  ///        zero for credits that did not originate from a draw
  /// @param legIndex Leg whose draw is being returned; its own draw record
  ///        decides which budget the refund restores
  function credit(
    address account,
    address token,
    uint256 amount,
    address orderAddress,
    uint256 legIndex,
    bytes32 requestHash,
    DrawLegKind kind
  ) external;

  /// @notice Returns an account's standing draw guardrails for one token
  /// @return perOrderCap Maximum outstanding net draw for one order
  /// @return budget Remaining aggregate draw budget
  /// @return authorizer Account authorizing each order this account funds
  /// @return expiry Timestamp after which draws are rejected; zero means never
  function drawConfig(
    address account,
    address token
  )
    external
    view
    returns (
      uint256 perOrderCap,
      uint256 budget,
      address authorizer,
      uint64 expiry
    );

  /// @notice Returns whether an account allowlists a resolver for draws
  /// @return allowed True when the resolver may draw from the account
  function drawResolvers(
    address account,
    address resolver
  ) external view returns (bool allowed);

  /// @notice Returns whether a leg already drew the account for an order
  /// @return drawn True when the account funded the order's leg
  function drawRecords(
    address orderAddress,
    address account,
    uint256 legIndex
  ) external view returns (bool drawn);

  /// @notice Returns an account's outstanding net draw for a token and order
  /// @return drawn Net draw amount the per-order cap is checked against
  function orderDraws(
    address orderAddress,
    address account,
    address token
  ) external view returns (uint256 drawn);

  /// @notice Returns an account's last applied draw nonce. Signed
  ///         updates must carry the next one; draw authorizations must be
  ///         signed against the current one
  /// @return nonce Last applied draw nonce
  function drawNonces(address account) external view returns (uint256 nonce);

  /// @notice Sets the caller's standing draw guardrails for one token
  /// @dev Advances the config epoch to invalidate all queued signed updates
  function setDrawConfig(address token, DrawConfig calldata config) external;

  /// @notice Sets an account's standing draw guardrails for one token
  ///         following an account-signed message
  function setDrawConfig(
    DrawConfigUpdate calldata update,
    bytes calldata signature
  ) external;

  /// @notice Allows or disallows a resolver to draw from the caller's balance
  /// @dev Advances the config epoch to invalidate all queued signed updates
  function setDrawResolver(address resolver, bool allowed) external;

  /// @notice Allows or disallows a resolver to draw from an account's balance
  ///         following an account-signed message
  function setDrawResolver(
    DrawResolverUpdate calldata update,
    bytes calldata signature
  ) external;

  /// @notice Invalidates outstanding draws and queued signed updates for the caller
  ///         by advancing its config epoch and moving its draw nonce
  /// @param nonce New draw nonce, picked at random between
  ///        `MIN_DRAW_NONCE_JUMP` and `MAX_DRAW_NONCE_JUMP` above the current
  ///        one; a predictable value kills nothing the authorizer pre-signed
  function revokeDrawAuthorizations(uint256 nonce) external;

  /// @notice Relay an account-signed revocation, including ERC-1271 accounts
  /// @dev Advances the config epoch and moves the draw nonce to the
  ///      signed value. Does not change stored guardrails or disable the
  ///      current authorizer. A pending revocation remains valid as ordinary
  ///      signed updates advance the nonce, for as long as the signed value
  ///      stays between `MIN_DRAW_NONCE_JUMP` and `MAX_DRAW_NONCE_JUMP` above
  ///      the current nonce; the bounds are checked when it executes.
  function revokeDrawAuthorizations(
    DrawRevocation calldata revocation,
    bytes calldata signature
  ) external;

  /// @notice Current signing epoch for config, resolver and revocation messages
  /// @dev Direct changes and explicit revocation advance it. Ordinary signed
  ///      updates preserve it so a batch can use consecutive nonces.
  /// @return epoch Current signing epoch
  function configEpoch(address account) external view returns (uint256 epoch);

  /// @notice Computes the EIP-712 digest for an account-signed revocation
  /// @return digest EIP-712 revocation digest
  function hashDrawRevocation(
    DrawRevocation calldata revocation
  ) external view returns (bytes32 digest);

  /// @notice Draws from an account balance for one order leg, within the
  ///         account's draw config and its authorizer's signed
  ///         authorization of the order and plan
  function debit(
    DrawRequest calldata draw,
    bytes calldata authorization
  ) external;

  /// @notice Pays out an account balance following an account-signed message
  function withdraw(
    PoolWithdrawal calldata withdrawal,
    bytes calldata signature
  ) external;

  /// @notice Burns one of the caller's withdrawal nonces, cancelling any
  ///         signed withdrawal that carries it
  function cancelWithdrawalNonce(uint256 nonce) external;

  /// @notice Returns the EIP-712 digest for a pool withdrawal
  /// @return digest EIP-712 withdrawal digest
  function hashWithdrawal(
    PoolWithdrawal calldata withdrawal
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a draw config update
  /// @return digest EIP-712 config update digest
  function hashDrawConfigUpdate(
    DrawConfigUpdate calldata update
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a draw resolver update
  /// @return digest EIP-712 resolver update digest
  function hashDrawResolverUpdate(
    DrawResolverUpdate calldata update
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a draw authorization
  /// @return digest EIP-712 draw authorization digest
  function hashDrawAuthorization(
    DrawAuthorization calldata authorization
  ) external view returns (bytes32 digest);
}
