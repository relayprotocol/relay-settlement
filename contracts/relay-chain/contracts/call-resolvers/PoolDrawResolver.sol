// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ExecuteAndWithdrawRequest, ICallResolver} from "./ICallResolver.sol";
import {DrawLeg, DrawLegKind, PoolResolverBase} from "./PoolResolverBase.sol";
import {Call} from "./ResolverSandbox.sol";

/// @title PoolDrawResolver
/// @author Relay Protocol
/// @notice Resolves orders by executing an ordered list of draw legs against
///         per-account balances in the funding pool each leg names. Fixed
///         legs draw an exact amount (for example to cover a fee or an order);
///         shortfall legs top the produced output up to an exact target
///         (exact output / fixed spread) and return surplus to the account
///         that funds shortfalls. Composed orders — for example an app
///         covering its fee alongside the platform account guaranteeing an
///         output peg — are payload shapes of this one contract.
/// @dev Every draw is bounded by the drawn account's standing draw
///      config in the leg's pool (resolver allowlist, per-order cap bounding
///      the account's summed draws, budget, expiry), gated by that account's
///      authorizer having signed off on this specific order, and recorded
///      one-draw-per-`(orderAddress, account, legIndex)`; draws only settle
///      inside an oracle-signed execution. A leg naming a pool where this
///      resolver holds no RESOLVER_ROLE, an account that has not allowlisted
///      it, or an order the account's authorizer did not authorize reverts the
///      settlement. All legs settle atomically: a revert anywhere restores
///      every account balance and leaves the draw records unset, keeping the
///      origin refund path open and retries safe.
contract PoolDrawResolver is PoolResolverBase {
  /// @notice Committed resolver plan for a pool-funded order
  /// @param legs Draw legs in execution order: fixed legs first (they run
  ///        before the request calls so drawn funds join the input notional),
  ///        then shortfall legs (they run after so they measure the produced
  ///        output)
  /// @param calls Request-level solver calls that convert the order input
  /// @param surplusPool Pool that receives unused request input and output
  ///        above the signed minimum; required when the plan has draw legs
  /// @param surplusAccount Account credited in surplusPool. Both surplus
  ///        fields may be zero only for a plan without draw legs, which then
  ///        returns all request tokens to the executor like basic resolution
  /// @param salt Per-order entropy. The oracle derives the signed request's
  ///        nonce from this plan (see {execute}), and the allocator requires
  ///        that nonce to be unique per order, so identical plans across
  ///        orders must differ here
  /// @dev This struct is the committed half of the payload. The per-leg draw
  ///      authorizations travel beside it, outside the commitment, so they
  ///      can be signed after the plan is attested — once the order address
  ///      exists — without changing the attested nonce. Each of them signs
  ///      `keccak256(abi.encode(execution))`, the same bytes the nonce
  ///      commits to, so the plan under an authorization cannot be swapped
  struct Execution {
    DrawLeg[] legs;
    Call[] calls;
    address surplusPool;
    address surplusAccount;
    bytes32 salt;
  }

  error MisorderedDrawLegs(uint256 index);
  error AuthorizationCountMismatch(uint256 legs, uint256 authorizations);

  /// @notice Creates a draw resolver bound to one RelayExecutor and RelayHub
  constructor(address executor, address hub) PoolResolverBase(executor, hub) {}

  /// @inheritdoc ICallResolver
  /// @dev `data` is `abi.encode(bytes executionData, bytes[] authorizations)`:
  ///      the encoded {Execution} plan, and one draw authorization per leg,
  ///      parallel by index (legs naming the same account and pool repeat the
  ///      same bytes). The signed request must commit to this resolver and the
  ///      exact plan:
  ///      `request.nonce == keccak256(resolver ‖ keccak256(executionData))`.
  ///      The RelayExecutor does not cover the payload in its digest, so this
  ///      check is what stops a front-runner from replaying a valid oracle
  ///      signature with substituted draw legs — changing a byte of the plan
  ///      requires a new attestation.
  ///
  ///      The authorizations are outside the commitment on purpose: each one
  ///      is `abi.encode(DrawAuthorization, bytes signature)`, an EIP-712
  ///      statement the leg's pool verifies against the account's configured
  ///      authorizer, scoped to the account, `request.orderAddress` (itself
  ///      covered by the executor digest) and `keccak256(executionData)` (the
  ///      plan hash this resolver hands the pool, covered by the nonce
  ///      above), so it needs no second commitment to mean what it means —
  ///      and signing it can wait until the plan is attested and the order
  ///      address is known. Tampering with one fails closed at the pool;
  ///      substituting a different valid one authorizes the identical
  ///      statement. Binding the plan is what stops the payload's author from
  ///      spending an authorization on a plan the authorizer never saw
  ///      (DEC-1955); the pool additionally checks the account's current
  ///      draw nonce and the authorization's deadline.
  ///
  ///      Fixed legs draw unconditionally — retry economics are handled by
  ///      each pool's per-`(requestHash, account, legIndex)` draw records and
  ///      by the operator composing payloads, not by fee gating — so the
  ///      `feesCharged` flag is ignored.
  function execute(
    ExecuteAndWithdrawRequest calldata request,
    bool,
    bytes calldata data
  ) external override nonReentrant {
    _requireExecutor();

    (bytes memory executionData, bytes[] memory authorizations) = abi.decode(
      data,
      (bytes, bytes[])
    );
    _requirePayloadCommitment(request, executionData);

    Execution memory execution = abi.decode(executionData, (Execution));
    uint256 length = execution.legs.length;
    if (authorizations.length != length) {
      revert AuthorizationCountMismatch(length, authorizations.length);
    }
    if (
      (execution.surplusPool == address(0)) !=
        (execution.surplusAccount == address(0)) ||
      (length != 0 && execution.surplusPool == address(0))
    ) {
      revert ZeroAddress();
    }

    // The plan every authorization must have signed is the committed
    // payload's hash, already proven above to be what the oracle attested
    DrawContext memory context = DrawContext({
      orderAddress: request.orderAddress,
      requestHash: _requestHash(request),
      planHash: keccak256(executionData)
    });

    uint256 i;
    for (; i < length && execution.legs[i].kind == DrawLegKind.FIXED; ++i) {
      _runDrawLeg(execution.legs[i], authorizations[i], context, i);
    }

    _runRequestCalls(request, execution.calls);

    for (; i < length; ++i) {
      if (execution.legs[i].kind == DrawLegKind.FIXED) {
        revert MisorderedDrawLegs(i);
      }
      _runDrawLeg(execution.legs[i], authorizations[i], context, i);
    }

    _settleRequestTokens(
      request,
      msg.sender,
      execution.surplusPool,
      execution.surplusAccount,
      context.requestHash
    );
  }
}
