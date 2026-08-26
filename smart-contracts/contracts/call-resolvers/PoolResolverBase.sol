// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ExecuteAndWithdrawRequest, ICallResolver} from "./ICallResolver.sol";
import {Call, ResolverSandbox} from "./ResolverSandbox.sol";
import {
  DrawLegKind,
  DrawRequest,
  IRelayFundingPool
} from "../funding-pools/IRelayFundingPool.sol";
import {Utils} from "../Utils.sol";

/// @notice One draw against a pool account inside an order settlement
/// @param pool Funding pool the leg's account, config, and draw record live
///        in; the resolver must hold RESOLVER_ROLE there. One pool per
///        environment stays a deployment choice, not a contract invariant
/// @param account Pool account whose balance funds (or receives) the leg
/// @param kind Settlement mode of the leg
/// @param tokenIn ERC-20 token drawn from the account's pool balance; must
///        equal tokenOut for SHORTFALL_TO_TARGET legs
/// @param tokenOut ERC-20 token the leg must produce
/// @param amount FIXED: exact amount drawn; SHORTFALL_TO_TARGET: target
///        tokenOut holding the leg tops up to (and trims surplus down to)
/// @param amountOutMinimum FIXED: minimum tokenOut the leg must produce;
///        unused for SHORTFALL_TO_TARGET legs, where the target is the check
/// @param calls Solver-supplied conversion calls run in the sandbox over the
///        drawn funds; may be empty when the draw needs no conversion
/// @dev The per-order draw authorization is not part of the leg: it travels
///      beside the committed execution payload (see
///      {PoolDrawResolver-execute}), because the authorizer signs it only
///      once the order address is known, after the payload is committed and
///      attested. The pool verifies it against the leg's account; the
///      resolver only forwards it
struct DrawLeg {
  address pool;
  address account;
  DrawLegKind kind;
  address tokenIn;
  address tokenOut;
  uint256 amount;
  uint256 amountOutMinimum;
  Call[] calls;
}

/// @title IRelayExecutorHasher
/// @author Relay Protocol
/// @notice Exposes RelayExecutor request hashing to call resolvers
interface IRelayExecutorHasher {
  /// @notice Returns the canonical EIP-712 digest for a request
  /// @return digest EIP-712 request digest
  function hashExecuteAndWithdrawRequest(
    ExecuteAndWithdrawRequest calldata request
  ) external view returns (bytes32 digest);
}

/// @title IRelayHubViewRegistry
/// @author Relay Protocol
/// @notice Resolves Hub token IDs into their ERC-20 representation contracts
interface IRelayHubViewRegistry {
  /// @notice Returns the ERC-20 representation for a Hub token ID
  /// @return ERC-20 view address, or zero if no view has been created
  function erc20Views(uint256 tokenId) external view returns (address);
}

/// @title PoolResolverBase
/// @author Relay Protocol
/// @notice Shared mechanics for pool-backed RelayExecutor call resolvers.
/// @dev This contract is the trusted settlement half: it holds `RESOLVER_ROLE`
///      on funding pools and performs every `debit` through the order-bound
///      `_runDrawLeg` path. It never executes solver-supplied calls itself —
///      those run in an unprivileged {ResolverSandbox} it owns, so a nested
///      `pool.debit()` smuggled into `calls[]` can never succeed.
abstract contract PoolResolverBase is ICallResolver, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice RelayExecutor allowed to invoke this resolver
  IRelayExecutorHasher public immutable EXECUTOR;

  /// @notice RelayHub used to resolve request token IDs into ERC-20 views
  IRelayHubViewRegistry public immutable HUB;

  /// @notice Unprivileged sandbox that runs solver-supplied calls
  ResolverSandbox public immutable SANDBOX;

  /// @notice Emitted after a draw leg settles against its pool account
  /// @param amountDrawn Amount of tokenIn debited from the account balance
  /// @param amountCredited Amount returned to the account balance: unspent
  ///        input for FIXED legs, surplus above the target for
  ///        SHORTFALL_TO_TARGET legs
  event DrawLegExecuted(
    address indexed orderAddress,
    address indexed pool,
    address indexed account,
    bytes32 requestHash,
    DrawLegKind kind,
    address tokenIn,
    address tokenOut,
    uint256 amountDrawn,
    uint256 amountCredited
  );

  error ZeroAddress();
  error UnauthorizedExecutor(address caller);
  error PayloadCommitmentMismatch(bytes32 expected, bytes32 actual);
  error TokenBalanceDecreased(address token, uint256 before_, uint256 after_);
  error InsufficientDrawLegOutput(
    address token,
    uint256 amount,
    uint256 minimum
  );
  error ShortfallTokenMismatch(address tokenIn, address tokenOut);
  error MissingTokenView(uint256 tokenId);

  /// @notice Creates a pool resolver bound to one RelayExecutor and RelayHub
  constructor(address executor, address hub) {
    if (executor == address(0) || hub == address(0)) {
      revert ZeroAddress();
    }
    EXECUTOR = IRelayExecutorHasher(executor);
    HUB = IRelayHubViewRegistry(hub);
    SANDBOX = new ResolverSandbox();
  }

  /// @notice Returns the canonical request hash from the trusted executor
  /// @return requestHash Canonical EIP-712 request digest
  function _requestHash(
    ExecuteAndWithdrawRequest calldata request
  ) internal view returns (bytes32 requestHash) {
    requestHash = EXECUTOR.hashExecuteAndWithdrawRequest(request);
  }

  /// @notice Ensures the resolver is being invoked by its configured executor
  function _requireExecutor() internal view {
    if (msg.sender != address(EXECUTOR)) {
      revert UnauthorizedExecutor(msg.sender);
    }
  }

  /// @notice Ensures the oracle-signed request commits to this resolver and
  ///         the exact execution payload it was invoked with
  /// @dev The executor's EIP-712 digest does not cover the resolver address or
  ///      its payload, so on its own a valid oracle signature could be
  ///      front-run with substituted draw legs. Requiring
  ///      `request.nonce == keccak256(resolver ‖ keccak256(executionData))`
  ///      closes that: the nonce is part of the signed digest, so changing a
  ///      byte of the execution payload — or redirecting it to another
  ///      resolver — requires a new oracle attestation. Every pool-privileged
  ///      resolver must call this before its first draw.
  ///
  ///      Draw authorizations are deliberately outside the committed bytes.
  ///      They are self-authenticating — EIP-712 signatures the pool verifies
  ///      against the account's configured authorizer, scoped to the account
  ///      and `request.orderAddress`, which the executor digest covers — so a
  ///      stripped or tampered authorization fails closed at the pool, and a
  ///      substituted valid one authorizes the identical statement. Leaving
  ///      them out lets the authorizer sign after the payload is attested,
  ///      once the order address is known.
  function _requirePayloadCommitment(
    ExecuteAndWithdrawRequest calldata request,
    bytes memory executionData
  ) internal view {
    bytes32 actual = keccak256(
      abi.encodePacked(address(this), keccak256(executionData))
    );
    if (request.nonce != actual) {
      revert PayloadCommitmentMismatch(request.nonce, actual);
    }
  }

  /// @notice Runs the request-level solver calls in the sandbox
  /// @dev Funds the sandbox with the request input, runs the calls there, and
  ///      sweeps the request input and output back to this settlement contract.
  function _runRequestCalls(
    ExecuteAndWithdrawRequest calldata request,
    Call[] memory calls
  ) internal {
    address inToken = _requestTokenView(request.inChainId, request.inCurrency);
    address outToken = _requestTokenView(
      request.outChainId,
      request.outCurrency
    );
    _fundSandbox(inToken);
    _runInSandbox(calls, inToken, outToken);
  }

  // slither-disable-start reentrancy-balance,reentrancy-events
  /// @notice Executes one draw leg against an account in the pool it names
  /// @dev The privileged `debit`/`credit` calls happen here in the trusted
  ///      settlement contract, bound to the current order via `orderAddress`
  ///      and the leg's payload position via `legIndex`, and to the leg's
  ///      account inside that pool's config gates: the resolver must hold
  ///      RESOLVER_ROLE on the leg's pool, be allowlisted by the account there,
  ///      and carry that account's authorizer signature for this order. Only
  ///      the leg's conversion `calls` run in the unprivileged sandbox.
  function _runDrawLeg(
    DrawLeg memory leg,
    bytes memory authorization,
    address orderAddress,
    bytes32 requestHash,
    uint256 legIndex
  ) internal {
    if (leg.pool == address(0)) {
      revert ZeroAddress();
    }
    if (leg.kind == DrawLegKind.FIXED) {
      _runFixedLeg(leg, authorization, orderAddress, requestHash, legIndex);
    } else {
      _runShortfallLeg(leg, authorization, orderAddress, requestHash, legIndex);
    }
  }

  /// @notice Performs the privileged pool debit for one leg
  /// @dev Separated so the seven-field `DrawRequest` construction lives in its
  ///      own frame; inlined in the leg runners it exceeds the stack.
  function _debitPool(
    DrawLeg memory leg,
    uint256 amount,
    bytes memory authorization,
    address orderAddress,
    bytes32 requestHash,
    uint256 legIndex
  ) internal {
    IRelayFundingPool(leg.pool).debit(
      DrawRequest({
        account: leg.account,
        token: leg.kind == DrawLegKind.FIXED ? leg.tokenIn : leg.tokenOut,
        amount: amount,
        orderAddress: orderAddress,
        requestHash: requestHash,
        legIndex: legIndex,
        kind: leg.kind
      }),
      authorization
    );
  }

  /// @notice Emits the per-leg settlement event
  /// @dev Separated for the same stack-depth reason as {_debitPool}: the
  ///      nine-argument emit inlined in the leg runners exceeds the stack.
  function _emitDrawLegExecuted(
    DrawLeg memory leg,
    address orderAddress,
    bytes32 requestHash,
    uint256 amountDrawn,
    uint256 amountCredited
  ) internal {
    emit DrawLegExecuted(
      orderAddress,
      leg.pool,
      leg.account,
      requestHash,
      leg.kind,
      leg.tokenIn,
      leg.tokenOut,
      amountDrawn,
      amountCredited
    );
  }

  /// @notice Draws an exact amount and verifies the produced output
  /// @dev The produced output stays in this settlement contract for the order;
  ///      unspent input (a cross-token conversion's leftovers) is credited
  ///      back to the leg's account.
  function _runFixedLeg(
    DrawLeg memory leg,
    bytes memory authorization,
    address orderAddress,
    bytes32 requestHash,
    uint256 legIndex
  ) internal {
    uint256 inputBefore = IERC20(leg.tokenIn).balanceOf(address(this));
    uint256 outputBefore = IERC20(leg.tokenOut).balanceOf(address(this));

    _debitPool(
      leg,
      leg.amount,
      authorization,
      orderAddress,
      requestHash,
      legIndex
    );
    uint256 amountDrawn = _increase(
      leg.tokenIn,
      inputBefore,
      IERC20(leg.tokenIn).balanceOf(address(this))
    );

    if (leg.calls.length != 0) {
      // Hand only the just-drawn funds to the unprivileged sandbox and run
      // the conversion there; results are swept back to this contract
      IERC20(leg.tokenIn).safeTransfer(address(SANDBOX), amountDrawn);
      _runInSandbox(leg.calls, leg.tokenIn, leg.tokenOut);
    }

    {
      uint256 amountProduced = _increase(
        leg.tokenOut,
        outputBefore,
        IERC20(leg.tokenOut).balanceOf(address(this))
      );
      if (amountProduced < leg.amountOutMinimum) {
        revert InsufficientDrawLegOutput(
          leg.tokenOut,
          amountProduced,
          leg.amountOutMinimum
        );
      }
    }

    // Return unspent input to the account that funded the draw. Skipped when
    // input and output are the same token, since that residue is the produced
    // output rather than leftover input
    uint256 amountCredited;
    if (leg.tokenIn != leg.tokenOut) {
      uint256 inputAfterCalls = IERC20(leg.tokenIn).balanceOf(address(this));
      if (inputAfterCalls > inputBefore) {
        amountCredited = inputAfterCalls - inputBefore;
        _creditPool(
          IRelayFundingPool(leg.pool),
          leg.account,
          leg.tokenIn,
          amountCredited,
          requestHash,
          leg.kind
        );
      }
    }

    _emitDrawLegExecuted(
      leg,
      orderAddress,
      requestHash,
      amountDrawn,
      amountCredited
    );
  }

  /// @notice Tops the leg token up to a target holding or trims surplus
  /// @dev Under-delivery draws exactly the missing amount from the account;
  ///      over-delivery credits the surplus back to the same account, so the
  ///      account that funds shortfalls is the one that earns surpluses.
  function _runShortfallLeg(
    DrawLeg memory leg,
    bytes memory authorization,
    address orderAddress,
    bytes32 requestHash,
    uint256 legIndex
  ) internal {
    if (leg.tokenIn != leg.tokenOut) {
      revert ShortfallTokenMismatch(leg.tokenIn, leg.tokenOut);
    }
    IERC20 token = IERC20(leg.tokenOut);
    uint256 target = leg.amount;
    uint256 balance = token.balanceOf(address(this));

    uint256 amountDrawn;
    if (balance < target) {
      amountDrawn = target - balance;
      _debitPool(
        leg,
        amountDrawn,
        authorization,
        orderAddress,
        requestHash,
        legIndex
      );

      if (leg.calls.length != 0) {
        uint256 received = _increase(
          leg.tokenOut,
          balance,
          token.balanceOf(address(this))
        );
        token.safeTransfer(address(SANDBOX), received);
        _runInSandbox(leg.calls, leg.tokenOut, leg.tokenOut);
      }

      balance = token.balanceOf(address(this));
      if (balance < target) {
        revert InsufficientDrawLegOutput(leg.tokenOut, balance, target);
      }
    }

    uint256 amountCredited = balance - target;
    if (amountCredited != 0) {
      _creditPool(
        IRelayFundingPool(leg.pool),
        leg.account,
        leg.tokenOut,
        amountCredited,
        requestHash,
        leg.kind
      );
    }

    _emitDrawLegExecuted(
      leg,
      orderAddress,
      requestHash,
      amountDrawn,
      amountCredited
    );
  }

  /// @notice Returns tokens from this contract to an account's pool balance,
  ///         tagged with the order and leg kind for per-order attribution
  function _creditPool(
    IRelayFundingPool pool,
    address account,
    address token,
    uint256 amount,
    bytes32 requestHash,
    DrawLegKind kind
  ) internal {
    IERC20(token).forceApprove(address(pool), amount);
    pool.credit(account, token, amount, requestHash, kind);
  }

  // slither-disable-end reentrancy-balance,reentrancy-events

  /// @notice Runs solver calls in the sandbox and sweeps the two tokens back
  /// @dev The caller must have already funded the sandbox with the input token.
  function _runInSandbox(
    Call[] memory calls,
    address inToken,
    address outToken
  ) internal {
    address[] memory returnTokens;
    if (inToken == outToken) {
      returnTokens = new address[](1);
      returnTokens[0] = inToken;
    } else {
      returnTokens = new address[](2);
      returnTokens[0] = inToken;
      returnTokens[1] = outToken;
    }
    SANDBOX.run(calls, returnTokens, address(this));
  }

  /// @notice Transfers this contract's full balance of a token to the sandbox
  function _fundSandbox(address token) internal {
    uint256 balance = IERC20(token).balanceOf(address(this));
    if (balance != 0) {
      IERC20(token).safeTransfer(address(SANDBOX), balance);
    }
  }

  /// @notice Returns the request input and output Hub tokens to the executor
  function _sweepRequestTokens(
    ExecuteAndWithdrawRequest calldata request,
    address recipient
  ) internal {
    address tokenIn = _requestTokenView(request.inChainId, request.inCurrency);
    address tokenOut = _requestTokenView(
      request.outChainId,
      request.outCurrency
    );
    _sweep(tokenIn, recipient);
    if (tokenOut != tokenIn) {
      _sweep(tokenOut, recipient);
    }
  }

  /// @notice Transfers a resolver's full balance of one token to a recipient
  function _sweep(address token, address recipient) internal {
    uint256 balance = IERC20(token).balanceOf(address(this));
    if (balance != 0) {
      IERC20(token).safeTransfer(recipient, balance);
    }
  }

  /// @notice Resolves request currency fields into a Hub ERC-20 view
  /// @return token ERC-20 view address
  function _requestTokenView(
    string calldata chainId,
    bytes calldata currency
  ) internal view returns (address token) {
    uint256 tokenId = Utils.generateTokenId(chainId, currency);
    token = HUB.erc20Views(tokenId);
    if (token == address(0)) {
      revert MissingTokenView(tokenId);
    }
  }

  /// @notice Returns a nonnegative token balance increase
  /// @return amount Balance increase
  function _increase(
    address token,
    uint256 before_,
    uint256 after_
  ) internal pure returns (uint256 amount) {
    if (after_ < before_) {
      revert TokenBalanceDecreased(token, before_, after_);
    }
    amount = after_ - before_;
  }
}
