// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Call, IMulticallRouter} from "./IMulticallRouter.sol";

/// @title MulticallRouter
/// @author Relay Protocol
/// @notice Executes depository-supplied call bundles and settles minimum-enforced fill payments
/// @dev Dumb executor: runs the supplied calls in order, enforcing only the
/// `DEPOSITORY_ROLE` gate, reentrancy, and self-call on the helpers. It makes no
/// guarantee about funds it holds — callers must settle and sweep within their own bundle,
/// because whatever a bundle leaves behind is takeable by anyone.
/// Invariants: a `DEPOSITORY_ROLE` holder must not be able to change any state beyond
/// `multicall` and `receive`, and the router must never hold a role or an allowance anywhere.
contract MulticallRouter is IMulticallRouter, AccessControl, ReentrancyGuard {
  using SafeTransferLib for address;

  /// @notice Admin role — can grant/revoke `ADMIN_ROLE` and `DEPOSITORY_ROLE`
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Depository role — addresses allowed to call `multicall`
  bytes32 public constant DEPOSITORY_ROLE = keccak256("DEPOSITORY_ROLE");

  /// @notice Revert if a settlement or sweep helper is called from outside the router
  error CallerNotSelf();

  /// @notice Revert if a call fails
  /// @param returnData The data returned from the failed call
  error CallFailed(bytes returnData);

  /// @notice Revert if the available balance is below the required minimum
  /// @param balance The available balance
  /// @param minimumAmount The minimum amount required
  error InsufficientSettlementBalance(uint256 balance, uint256 minimumAmount);

  /// @notice Revert if a recipient is the zero address
  error InvalidRecipient();

  /// @notice Revert if a required address argument is the zero address
  error ZeroAddress();

  /// @notice Revert if a role holder tries to renounce its own role
  error RenounceNotAllowed();

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @dev `ADMIN_ROLE` administers itself and `DEPOSITORY_ROLE`, so a zero admin would
  /// leave both roles permanently unmanageable
  constructor(address admin) {
    if (admin == address(0)) {
      revert ZeroAddress();
    }

    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(DEPOSITORY_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);
  }

  /// @inheritdoc IMulticallRouter
  /// @dev Executes the calls in order, honoring each call's `allowFailure` flag
  function multicall(
    Call[] calldata calls
  ) external payable onlyRole(DEPOSITORY_ROLE) nonReentrant {
    uint256 length = calls.length;
    for (uint256 i; i < length; ++i) {
      // slither-disable-next-line arbitrary-send-eth,calls-loop
      (bool success, bytes memory returnData) = calls[i].to.call{
        value: calls[i].value
      }(calls[i].data);

      if (!success && !calls[i].allowFailure) {
        revert CallFailed(returnData);
      }
    }
  }

  /// @notice Sweep the router's full balance of each currency to the recipient
  /// @param currencies Currencies to sweep; the zero address denotes the native
  /// currency and zero balances are skipped
  /// @param recipient The address receiving the swept balances
  /// @dev Only callable by the router itself as an inner multicall call; bundle it as
  /// the last call so no residual is stranded
  function sweep(address[] calldata currencies, address recipient) external {
    if (msg.sender != address(this)) {
      revert CallerNotSelf();
    }
    if (recipient == address(0)) {
      revert InvalidRecipient();
    }

    uint256 length = currencies.length;
    for (uint256 i; i < length; ++i) {
      address currency = currencies[i];
      uint256 balance = _selfBalance(currency);
      if (balance != 0) {
        _transfer(currency, recipient, balance);
      }
    }
  }

  /// @notice Transfer the router's full balance of a currency to the recipient
  /// @param currency The currency to settle; the zero address denotes the native currency
  /// @param recipient The address receiving the settlement
  /// @param minimumAmount The minimum amount that must be available
  /// @dev Only callable by the router itself as an inner multicall call; reverts
  /// when the balance is below the minimum
  function settle(
    address currency,
    address recipient,
    uint256 minimumAmount
  ) external {
    if (msg.sender != address(this)) {
      revert CallerNotSelf();
    }
    if (recipient == address(0)) {
      revert InvalidRecipient();
    }

    uint256 balance = _selfBalance(currency);
    if (balance < minimumAmount) {
      revert InsufficientSettlementBalance(balance, minimumAmount);
    }

    _transfer(currency, recipient, balance);
  }

  /// @notice The router's own balance of a currency
  /// @param currency The currency to read; the zero address denotes the native currency
  /// @return The router's balance of `currency`
  function _selfBalance(address currency) internal view returns (uint256) {
    if (currency == address(0)) {
      return address(this).balance;
    } else {
      return currency.balanceOf(address(this));
    }
  }

  /// @notice Transfer a currency out of the router
  /// @param currency The currency to transfer; the zero address denotes the native currency
  /// @param recipient The address receiving the transfer
  /// @param amount The amount to transfer
  function _transfer(
    address currency,
    address recipient,
    uint256 amount
  ) internal {
    if (currency == address(0)) {
      recipient.safeTransferETH(amount);
    } else {
      currency.safeTransfer(recipient, amount);
    }
  }

  /// @inheritdoc AccessControl
  /// @dev `DEPOSITORY_ROLE` cannot be renounced: the depository is `msg.sender` for the
  /// router's inner calls, and `renounceRole` authorizes on `callerConfirmation` alone
  function renounceRole(
    bytes32 role,
    address callerConfirmation
  ) public override {
    if (role == DEPOSITORY_ROLE) {
      revert RenounceNotAllowed();
    }

    super.renounceRole(role, callerConfirmation);
  }

  /// @notice Receive native currency from depository withdrawals
  receive() external payable {}
}
