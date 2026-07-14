// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Fee charged in the input currency
/// @param recipient Hub account that receives the fee
/// @param amount Fee amount denominated in the input currency
struct Fee {
  address recipient;
  uint256 amount;
}

/// @notice Oracle-signed execute and withdraw request
/// @param inChainId Chain id of the input currency
/// @param inCurrency Encoded address of the input currency
/// @param outChainId Chain id of the withdrawal chain
/// @param outCurrency Encoded address of the output currency to withdraw
/// @param outAmountMinimum Minimum withdrawal currency amount after executing calls
/// @param depository Encoded address of the depository on the withdrawal chain
/// @param orderAddress Hub account that currently holds the order funds
/// @param receiver Encoded address of the receiver of the withdrawn funds
/// @param data Additional data to be passed to the payload builder
/// @param fees Fees charged in the input currency before executing calls
/// @param nonce Nonce forwarded to the allocator withdrawal request
/// @param deadline Timestamp after which the request can no longer be executed
struct ExecuteAndWithdrawRequest {
  string inChainId;
  bytes inCurrency;
  string outChainId;
  bytes outCurrency;
  uint256 outAmountMinimum;
  bytes depository;
  address orderAddress;
  bytes receiver;
  bytes data;
  Fee[] fees;
  bytes32 nonce;
  uint256 deadline;
}

/// @title ICallResolver
/// @author Relay Protocol
/// @notice Interface for solver-controlled sandboxes that resolve an order by
///         running untrusted logic in isolation from the RelayExecutor's funds
///         and privileges.
/// @dev The RelayExecutor funds a caller-supplied implementation of this
///      interface with the current order's input currency and then invokes
///      `execute`. The implementation is fully controlled by the solver, so it
///      can embed any logic it needs to convert the input into the output
///      currency. The full oracle-signed request is forwarded so the resolver
///      has complete context (input/output currencies, minimum output,
///      receiver, fees, etc.).
///
///      Security relies on the fact that the call runs with `msg.sender` set to
///      the resolver itself, never the RelayExecutor. Because the resolver is
///      expected to be a plain, privilege-less contract (it is never granted a
///      Hub operator role), it can never use the RelayExecutor's operator role
///      to mint, burn or move funds it was not explicitly given. The worst a
///      malicious resolver can do is divert the single order's funded input; if
///      it does, the resulting output falls below the signed minimum and the
///      RelayExecutor reverts the whole transaction.
///
///      The resolver is responsible for returning the resulting output currency
///      to the caller (the RelayExecutor). Any funds left behind are not swept
///      automatically.
interface ICallResolver {
  /// @notice Runs solver-controlled logic against the funded input currency
  /// @dev Invoked by the RelayExecutor after funding this contract with the
  ///      order's input currency. Implementations must return the output
  ///      currency to `msg.sender` (the RelayExecutor) for the withdrawal to
  ///      succeed. The funded input is net of any fees charged this execution
  ///      (see `feesCharged`).
  /// @param request Oracle-signed execute and withdraw request being resolved
  /// @param feesCharged Whether fees were charged from the input this execution.
  ///        Fees are charged at most once per order address, so this is false
  ///        when the order address had already been charged by a prior execution
  ///        (in which case the full input amount was funded in).
  /// @param data Arbitrary solver-supplied data
  function execute(
    ExecuteAndWithdrawRequest calldata request,
    bool feesCharged,
    bytes calldata data
  ) external;
}
