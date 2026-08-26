// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Draw-leg settlement modes
/// @dev FIXED legs draw an exact amount unconditionally; SHORTFALL_TO_TARGET
///      legs draw only what is missing to reach a target output holding and
///      return any surplus above the target to the same account. Carried on
///      `Drawn`/`Credited` events so sponsorship and exact-output
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
/// @param perOrderCap Maximum total amount one order's draws may take,
///        bounding the sum of the account's legs in the order
/// @param budget Remaining aggregate draw budget; `type(uint256).max` means
///        the budget is unlimited and is not decremented
/// @param authorizer Account whose signature authorizes each order this
///        account funds. Any wallet works (EOA or ERC-1271); the account picks
///        it when signing the config and revokes by re-signing. Canonically
///        the platform's operator key, so the account itself stays offline.
///        Zero closes the token for draws
/// @param expiry Timestamp after which draws are rejected; zero means never
/// @dev `authorizer` and `expiry` share a slot, so `debit` reads the whole
///      config in three loads rather than four
struct SponsorshipConfig {
  uint256 perOrderCap;
  uint256 budget;
  address authorizer;
  uint64 expiry;
}

/// @notice Authorizer-signed statement that one order may draw an account
/// @dev The standing config says *how much* an account will fund; this says
///      *which orders*. That predicate is off-chain knowledge (order X came
///      through this account's integration), so it cannot be derived on-chain
///      and cannot be attested by the oracle, which only certifies facts about
///      a deposit. Without it, any party able to obtain an attestation could
///      name any consenting account as a draw leg.
/// @param account Pool account the authorization draws from
/// @param orderAddress Order address the draws are authorized for; scopes the
///        authorization to one order, and replay within that order is bounded
///        by the per-order draw records and cap
struct DrawAuthorization {
  address account;
  address orderAddress;
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
/// @param legIndex Position of the leg in the resolver payload
/// @param kind Settlement mode of the leg
struct DrawRequest {
  address account;
  address token;
  uint256 amount;
  address orderAddress;
  bytes32 requestHash;
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

/// @notice Account-signed instruction to set the account's sponsorship config
///         for one token, relayable by anyone
/// @param account Pool account whose config is set; must sign the message
/// @param token ERC-20 token the config applies to
/// @param authorizer Account authorizing each order this account funds; zero
///        closes the token for draws
/// @param perOrderCap Maximum total amount one order's draws may take
/// @param budget Remaining aggregate draw budget; `type(uint256).max` means
///        the budget is unlimited and is not decremented
/// @param expiry Timestamp after which draws are rejected; zero means never
/// @param nonce Account-scoped replay-protection nonce, shared with resolver
///        updates
/// @param deadline Timestamp after which the update is invalid
struct SponsorshipConfigUpdate {
  address account;
  address token;
  address authorizer;
  uint256 perOrderCap;
  uint256 budget;
  uint64 expiry;
  uint256 nonce;
  uint256 deadline;
}

/// @notice Account-signed instruction to allow or disallow a draw resolver
///         for the account, relayable by anyone
/// @param account Pool account whose allowlist is updated; must sign the message
/// @param resolver Resolver contract the update applies to
/// @param allowed True to allow the resolver to draw from the account
/// @param nonce Account-scoped replay-protection nonce, shared with config
///        updates
/// @param deadline Timestamp after which the update is invalid
struct SponsorshipResolverUpdate {
  address account;
  address resolver;
  bool allowed;
  uint256 nonce;
  uint256 deadline;
}

/// @title IRelayFundingPool
/// @author Relay Protocol
/// @notice Interface for independently deployed, role-controlled funding pools
interface IRelayFundingPool {
  /// @notice Returns the pool balance a token holds for an account
  /// @return balance Attributed token balance
  function balances(
    address account,
    address token
  ) external view returns (uint256 balance);

  /// @notice Deposits tokens from the caller into an account's pool balance
  function depositFor(address account, address token, uint256 amount) external;

  /// @notice Returns tokens from the calling resolver to an account's
  ///         balance, tagged with the order and leg kind that produced them
  function credit(
    address account,
    address token,
    uint256 amount,
    bytes32 requestHash,
    DrawLegKind kind
  ) external;

  /// @notice Returns an account's standing draw guardrails for one token
  /// @return perOrderCap Maximum total amount one order's draws may take
  /// @return budget Remaining aggregate draw budget
  /// @return authorizer Account authorizing each order this account funds
  /// @return expiry Timestamp after which draws are rejected; zero means never
  function sponsorshipConfig(
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
  function sponsorshipResolvers(
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

  /// @notice Returns the total an account's legs drew of a token for an order
  /// @return drawn Summed draw amount the per-order cap is checked against
  function orderDraws(
    address orderAddress,
    address account,
    address token
  ) external view returns (uint256 drawn);

  /// @notice Sets the caller's standing draw guardrails for one token
  function setSponsorshipConfig(
    address token,
    SponsorshipConfig calldata config
  ) external;

  /// @notice Sets an account's standing draw guardrails for one token
  ///         following an account-signed message
  function setSponsorshipConfig(
    SponsorshipConfigUpdate calldata update,
    bytes calldata signature
  ) external;

  /// @notice Allows or disallows a resolver to draw from the caller's balance
  function setSponsorshipResolver(address resolver, bool allowed) external;

  /// @notice Allows or disallows a resolver to draw from an account's balance
  ///         following an account-signed message
  function setSponsorshipResolver(
    SponsorshipResolverUpdate calldata update,
    bytes calldata signature
  ) external;

  /// @notice Draws from an account balance for one order leg, within the
  ///         account's sponsorship config and its authorizer's per-order
  ///         authorization
  function debit(
    DrawRequest calldata draw,
    bytes calldata authorization
  ) external;

  /// @notice Pays out an account balance following an account-signed message
  function withdraw(
    PoolWithdrawal calldata withdrawal,
    bytes calldata signature
  ) external;

  /// @notice Returns the EIP-712 digest for a pool withdrawal
  /// @return digest EIP-712 withdrawal digest
  function hashWithdrawal(
    PoolWithdrawal calldata withdrawal
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a sponsorship config update
  /// @return digest EIP-712 config update digest
  function hashSponsorshipConfigUpdate(
    SponsorshipConfigUpdate calldata update
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a sponsorship resolver update
  /// @return digest EIP-712 resolver update digest
  function hashSponsorshipResolverUpdate(
    SponsorshipResolverUpdate calldata update
  ) external view returns (bytes32 digest);

  /// @notice Returns the EIP-712 digest for a per-order draw authorization
  /// @return digest EIP-712 draw authorization digest
  function hashDrawAuthorization(
    DrawAuthorization calldata authorization
  ) external view returns (bytes32 digest);
}
