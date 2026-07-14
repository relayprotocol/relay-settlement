// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
  ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ExecuteAndWithdrawRequest, ICallResolver} from "./ICallResolver.sol";
import {RelayHub} from "../RelayHub.sol";

/// @title BasicCallResolver
/// @author Relay Protocol
/// @notice Reference `ICallResolver` implementation that runs a list of
///         untrusted, caller-supplied calls and then sweeps caller-specified
///         token balances to caller-specified recipients.
/// @dev This is a convenience implementation for solvers that only need generic
///      multicall behaviour. Solvers are free to deploy their own
///      `ICallResolver` with arbitrary custom logic instead.
///
///      Like any `ICallResolver`, this contract intentionally holds no roles (it
///      is never a Hub operator) and only ever custodies the exact input pushed
///      to it for a single execution. Because the arbitrary calls run with
///      `msg.sender` equal to this contract, the worst a malicious call can do is
///      move the funds that were pushed in for the current order. If those funds
///      are diverted, the RelayExecutor's post-run minimum-output check fails and
///      the whole transaction reverts, so no funds can actually be stolen.
contract BasicCallResolver is ICallResolver, ReentrancyGuard {
  /// @notice Unsigned arbitrary call executed between funding and sweeping
  /// @param to Call target
  /// @param data Calldata to pass to the target
  struct Call {
    address to;
    bytes data;
  }

  /// @notice Token balance sweep executed after all calls complete
  /// @param recipient Hub account that receives this contract's token balance
  /// @param tokenId Hub token id to sweep
  struct Sweep {
    address recipient;
    uint256 tokenId;
  }

  // Errors

  /// @notice Thrown when an arbitrary call reverts
  error CallFailed(uint256 index, address target, bytes reason);

  /// @notice Thrown when sweeping funds back to the caller unexpectedly fails
  error SweepFailed(uint256 tokenId, uint256 amount);

  // Constants

  /// @notice Hub contract
  RelayHub public immutable HUB;

  // Constructor

  /// @notice Constructor
  /// @param hub The hub contract
  constructor(address hub) {
    HUB = RelayHub(hub);
  }

  // Public methods

  /// @notice Runs the supplied calls, then sweeps requested token balances
  /// @dev The caller (typically the RelayExecutor) funds this contract with the
  ///      input currency before invoking this method. After the calls run, this
  ///      contract sweeps every requested token id with a non-zero balance to its
  ///      requested recipient. The forwarded request and `feesCharged` flag are
  ///      unused by this generic implementation.
  /// @param data ABI-encoded `(Call[] calls, Sweep[] sweeps)`
  function execute(
    ExecuteAndWithdrawRequest calldata,
    bool,
    bytes calldata data
  ) external nonReentrant {
    (Call[] memory calls, Sweep[] memory sweeps) = abi.decode(
      data,
      (Call[], Sweep[])
    );

    uint256 callsLength = calls.length;
    for (uint256 i; i < callsLength; ++i) {
      Call memory call_ = calls[i];
      // slither-disable-next-line calls-loop
      (bool success, bytes memory result) = call_.to.call(call_.data);
      if (!success) {
        revert CallFailed(i, call_.to, result);
      }
    }

    uint256 sweepsLength = sweeps.length;
    for (uint256 i; i < sweepsLength; ++i) {
      Sweep memory sweep = sweeps[i];
      uint256 balance = HUB.balanceOf(address(this), sweep.tokenId);
      if (balance != 0) {
        if (!HUB.transfer(sweep.recipient, sweep.tokenId, balance)) {
          revert SweepFailed(sweep.tokenId, balance);
        }
      }
    }
  }
}
