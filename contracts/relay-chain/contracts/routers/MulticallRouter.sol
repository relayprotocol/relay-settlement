// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {Call, IMulticallRouter} from "./IMulticallRouter.sol";

/// @title MulticallRouter
/// @author Relay Protocol
/// @notice Destination-chain router for routed withdrawals: the depository transfers the withdrawn
/// currency here, then calls `multicall` so the bundle swaps from this balance and pays the recipient
/// @dev Not a general-purpose multicall: only a `DEPOSITORY_ROLE` holder can call `multicall`, every
/// inner call runs from this address, and nothing is meant to stay between executions. It makes no
/// guarantee about funds it holds — a bundle must `settle` and `sweep` within itself, because
/// whatever is left behind is takeable by the next bundle or by any spender an earlier bundle
/// approved, and any allowance granted to this contract is spendable by the next bundle. The
/// protocol-composed bundle sweeps only the withdrawn, fill and native currencies; a bundle that
/// swaps through other currencies must sweep them itself.
/// Invariants: a `DEPOSITORY_ROLE` holder must not be able to change any state beyond
/// `multicall` and `receive`, and the router must never hold a role or an allowance anywhere.
contract MulticallRouter is IMulticallRouter, AccessControl, ReentrancyGuard {
  using SafeTransferLib for address;

  /// @notice Admin role — can grant/revoke `ADMIN_ROLE` and `DEPOSITORY_ROLE`
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Depository role — addresses allowed to call `multicall`
  bytes32 public constant DEPOSITORY_ROLE = keccak256("DEPOSITORY_ROLE");

  /// @notice ERC1820 registry used by ERC777 tokens to look up transfer hooks
  address internal constant ERC1820_REGISTRY =
    0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;

  /// @notice Legacy ERC820 registry used by early ERC777 tokens
  address internal constant ERC820_REGISTRY =
    0x820b586C8C28125366C998641B09DCbE7d4cBF06;

  /// @notice Revert if a call targets an ERC1820 or ERC820 hook registry
  /// @param target The rejected call target
  error InvalidTarget(address target);

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

  /// @notice Revert if a role is granted to the router itself
  error GrantToSelfNotAllowed();

  /// @notice Revert if a currency's balance cannot be read
  /// @param currency The currency whose `balanceOf` call failed
  error BalanceReadFailed(address currency);

  /// @notice Emitted when `settle` pays out the router's balance of a currency
  /// @param currency The settled currency; the zero address denotes the native currency
  /// @param recipient The address receiving the settlement
  /// @param amount The amount paid out
  /// @param minimumAmount The minimum amount the settlement required
  event Settled(
    address indexed currency,
    address indexed recipient,
    uint256 amount,
    uint256 minimumAmount
  );

  /// @notice Emitted when `sweep` pays out a non-zero balance of a currency
  /// @param currency The swept currency; the zero address denotes the native currency
  /// @param recipient The address receiving the swept balance
  /// @param amount The amount paid out
  event Swept(
    address indexed currency,
    address indexed recipient,
    uint256 amount
  );

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
  /// @dev The withdrawn currency is already on this contract when this runs; the calls execute
  /// in order, honoring each call's `allowFailure` flag. Hook registry targets are
  /// always rejected, regardless of `allowFailure`
  function multicall(
    Call[] calldata calls
  ) external payable onlyRole(DEPOSITORY_ROLE) nonReentrant {
    uint256 length = calls.length;
    for (uint256 i; i < length; ++i) {
      address target = calls[i].to;
      // Calls run as the router, so registry calls could install its ERC777
      // hooks or hand control of its registry entries to another manager.
      if (target == ERC1820_REGISTRY || target == ERC820_REGISTRY) {
        revert InvalidTarget(target);
      }

      // slither-disable-next-line arbitrary-send-eth,calls-loop
      (bool success, bytes memory returnData) = target.call{
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
  /// the last call so no residual is stranded, and list every intermediate currency of the
  /// swap route — the protocol bundle lists only the withdrawn, fill and native currencies
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
        emit Swept(currency, recipient, balance);
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
    emit Settled(currency, recipient, balance, minimumAmount);
  }

  /// @notice The router's own balance of a currency
  /// @param currency The currency to read; the zero address denotes the native currency
  /// @return The router's balance of `currency`
  /// @dev Reverts if the `balanceOf` call fails or returns less than a word, so a
  /// failed read is never mistaken for an empty balance
  function _selfBalance(address currency) internal view returns (uint256) {
    if (currency == address(0)) {
      return address(this).balance;
    }

    // slither-disable-next-line calls-loop
    (bool success, bytes memory returnData) = currency.staticcall(
      abi.encodeCall(IERC20.balanceOf, (address(this)))
    );
    if (!success || returnData.length < 32) {
      revert BalanceReadFailed(currency);
    }

    return abi.decode(returnData, (uint256));
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

  /// @notice Grant a role, rejecting the router itself as the grantee
  /// @param role The role to grant
  /// @param account The account receiving the role
  /// @return Whether the role was newly granted
  /// @dev The router can never hold a role, since any bundle runs with the router as
  /// `msg.sender`
  function _grantRole(
    bytes32 role,
    address account
  ) internal override returns (bool) {
    if (account == address(this)) {
      revert GrantToSelfNotAllowed();
    }

    return super._grantRole(role, account);
  }

  /// @notice Receive native currency from depository withdrawals
  receive() external payable {}
}
