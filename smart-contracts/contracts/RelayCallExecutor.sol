// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RelayHub} from "./RelayHub.sol";

/// @title RelayCallExecutor
/// @author Relay Protocol
/// @notice Sandbox that runs untrusted, caller-supplied calls in isolation from
///         the RelayExecutor's funds and privileges.
/// @dev This contract intentionally holds no roles (it is never a Hub operator)
///      and only ever custodies the exact input pushed to it for a single
///      execution. Because the arbitrary calls run with `msg.sender` equal to
///      this contract, the worst a malicious call can do is move the funds that
///      were pushed in for the current order. If those funds are diverted, the
///      RelayExecutor's post-run minimum-output check fails and the whole
///      transaction reverts, so no funds can actually be stolen.
contract RelayCallExecutor is ReentrancyGuard {
  /// @notice Unsigned arbitrary call executed between funding and withdrawal
  /// @param to Call target
  /// @param data Calldata to pass to the target
  struct Call {
    address to;
    bytes data;
  }

  // Errors

  /// @notice Thrown when a caller other than the executor invokes `run`
  error OnlyExecutor(address caller);

  /// @notice Thrown when an arbitrary call reverts
  error CallFailed(uint256 index, address target, bytes reason);

  /// @notice Thrown when sweeping funds back to the executor unexpectedly fails
  error SweepFailed(uint256 tokenId, uint256 amount);

  // Constants

  /// @notice Hub contract
  RelayHub public immutable HUB;

  /// @notice Executor allowed to invoke `run`
  address public immutable EXECUTOR;

  // Constructor

  /// @notice Constructor
  /// @param hub The hub contract
  /// @param executor The executor allowed to invoke `run`
  constructor(address hub, address executor) {
    HUB = RelayHub(hub);
    EXECUTOR = executor;
  }

  // Public methods

  /// @notice Runs the supplied calls, then sweeps the given tokens back to the executor
  /// @dev Only callable by the executor. Any funds left in this contract for the
  ///      listed token ids are returned to the executor after the calls run.
  /// @param calls Unsigned calls to execute
  /// @param sweepTokenIds Token ids to sweep back to the executor after the calls
  function run(
    Call[] calldata calls,
    uint256[] calldata sweepTokenIds
  ) external nonReentrant {
    if (msg.sender != EXECUTOR) {
      revert OnlyExecutor(msg.sender);
    }

    uint256 callsLength = calls.length;
    for (uint256 i; i < callsLength; ++i) {
      Call calldata call_ = calls[i];
      // slither-disable-next-line calls-loop
      (bool success, bytes memory result) = call_.to.call(call_.data);
      if (!success) {
        revert CallFailed(i, call_.to, result);
      }
    }

    uint256 sweepLength = sweepTokenIds.length;
    for (uint256 i; i < sweepLength; ++i) {
      uint256 tokenId = sweepTokenIds[i];
      // slither-disable-next-line calls-loop
      uint256 balance = HUB.balanceOf(address(this), tokenId);
      if (balance != 0) {
        // slither-disable-next-line calls-loop
        if (!HUB.transfer(EXECUTOR, tokenId, balance)) {
          revert SweepFailed(tokenId, balance);
        }
      }
    }
  }
}
