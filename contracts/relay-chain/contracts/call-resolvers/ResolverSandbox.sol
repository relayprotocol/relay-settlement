// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Arbitrary call executed inside the sandbox
struct Call {
  address to;
  bytes data;
}

/// @title ResolverSandbox
/// @author Relay Protocol
/// @notice Unprivileged executor for solver-supplied calls. Holds no roles on any
///         funding pool, so a call it runs can never invoke a privileged
///         `pool.debit()` (it satisfies neither `onlyRole(RESOLVER_ROLE)` nor
///         `authorization.resolver == msg.sender`). Deployed and owned by the one
///         trusted settlement resolver that drives it.
contract ResolverSandbox {
  using SafeERC20 for IERC20;

  /// @notice Settlement resolver allowed to drive this sandbox
  address public immutable OWNER;

  error UnauthorizedCaller(address caller);
  error CallFailed(uint256 index, address target, bytes reason);

  /// @notice Binds the sandbox to its deploying settlement resolver as sole owner
  constructor() {
    OWNER = msg.sender;
  }

  /// @notice Runs solver calls, then returns the named token balances to the recipient
  /// @dev The funds to operate on must already sit in this sandbox; the caller
  ///      funds it beforehand and receives the results back via `returnTokens`.
  ///      Only the owner (the trusted settlement resolver) may call.
  /// @param calls Solver-supplied calls to execute
  /// @param returnTokens Tokens whose full balance is swept back after the calls
  /// @param recipient Address that receives the swept balances
  function run(
    Call[] calldata calls,
    address[] calldata returnTokens,
    address recipient
  ) external {
    if (msg.sender != OWNER) {
      revert UnauthorizedCaller(msg.sender);
    }

    uint256 length = calls.length;
    for (uint256 i; i < length; ++i) {
      // slither-disable-next-line calls-loop
      (bool success, bytes memory result) = calls[i].to.call(calls[i].data);
      if (!success) {
        revert CallFailed(i, calls[i].to, result);
      }
    }

    uint256 tokenCount = returnTokens.length;
    for (uint256 j; j < tokenCount; ++j) {
      uint256 balance = IERC20(returnTokens[j]).balanceOf(address(this));
      if (balance != 0) {
        IERC20(returnTokens[j]).safeTransfer(recipient, balance);
      }
    }
  }
}
