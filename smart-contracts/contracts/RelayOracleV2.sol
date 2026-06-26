// SPDX-License-Identifier: MIT
// ABOUTME: Oracle contract: MINT/BURN/TRANSFER plus the fast-finality FAST_MINT action (fee split + rate-limit).
// ABOUTME: Dedups against the old oracle's idempotency keys so keys settled there can't replay here.
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {RelayHub} from "./RelayHub.sol";
import {RelayOracle} from "./RelayOracle.sol";
import {RelayFastRateLimiter} from "./RelayFastRateLimiter.sol";

/// @title RelayOracleV2
/// @author Relay Protocol
/// @notice Oracle contract that adds the fast-finality `FAST_MINT` action on top of the
///         MINT / BURN / TRANSFER actions of `RelayOracle`. A fast deposit is minted in two
///         parts — a fee to the fee recipient and the net amount to the recipient — after the
///         full at-risk amount clears the on-chain rate limiter.
/// @dev    Idempotency is checked against both this contract's and the old oracle's `isExecuted`
///         maps, so a key already settled on the old oracle cannot be replayed here.
contract RelayOracleV2 is AccessControl, EIP712 {
  using SignatureChecker for address;

  // Structs

  enum ActionType {
    MINT,
    BURN,
    TRANSFER,
    FAST_MINT
  }

  struct Execution {
    bytes32 idempotencyKey;
    bytes[] actions;
  }

  // Events

  /// @notice Emitted when actions were executed
  event Executed(bytes32 indexed idempotencyKey, bytes[] actions);

  /// @notice Emitted when an action failed to execute in a batch
  event ExecutionFailed(bytes32 indexed idempotencyKey, bytes[] actions);

  /// @notice Emitted when the fast-mint rate limiter address is set
  event RateLimiterSet(address indexed rateLimiter);

  /// @notice Emitted on a FAST_MINT for observability. Not consumed by settlement: the recipient
  ///         holds exactly the net amount, which is the attested deposit amount, so
  ///         fill/refund/recover use the attested amount directly and never read the fee.
  event FastMint(
    bytes32 indexed idempotencyKey,
    address hubToAddress,
    uint256 hubTokenId,
    uint256 amount,
    uint256 feeBps,
    address feeRecipient
  );

  // Errors
  error ZeroAddress();
  /// @notice A non-zero `oldOracle` constructor argument did not respond as a live `RelayOracle`.
  ///         `OLD_ORACLE` is immutable and consulted before every execution, so a wrong-type target
  ///         would brick all execution with no recovery; this is caught at deploy time instead.
  error InvalidOldOracle(address oldOracle);
  error OldOracleHubMismatch(address oldOracle);
  error AlreadyExecuted(bytes32 idempotencyKey);
  error UnauthorizedOracle(address oracle);
  error InvalidSignature(address oracle);
  error InvalidActionType(uint8 actionType);
  error RateLimiterNotSet();
  error InvalidFeeBps(uint256 feeBps);
  error InvalidFeeRecipient();
  /// @notice A FAST_MINT was rejected by the rate limiter (over budget / fast unavailable). The
  ///         whole execution reverts (nothing minted, idempotency key not consumed) so the deposit
  ///         can be re-attested as slow.
  error FastMintRejected();
  /// @notice `executeMultiple` was called with mismatched executions/signatures array lengths
  error LengthMismatch();

  // Roles

  /// @notice Admin role
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice Hub contract
  RelayHub public immutable HUB;

  /// @notice Previous `RelayOracle` whose idempotency keys must still be honoured. May be the zero
  ///         address when there is no predecessor, in which case only this contract's keys apply.
  RelayOracle public immutable OLD_ORACLE;

  /// @notice Denominator for `feeBps`, a 1e18-scaled fraction of the deposit amount (1% = 1e16);
  ///         `fee = amount * feeBps / BPS_DENOMINATOR`.
  uint256 public constant BPS_DENOMINATOR = 1e18;

  bytes32 private constant _EXECUTION_TYPEHASH =
    keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

  // Fields

  /// @notice Mapping of idempotency key to execution status
  mapping(bytes32 => bool) public isExecuted;

  /// @notice Rate limiter consulted on every `FAST_MINT`. Settable by the admin (swappable); a
  ///         zero address disables fast minting (fail-closed).
  RelayFastRateLimiter public rateLimiter;

  // Constructor

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param hub The hub contract
  /// @param oldOracle The previous RelayOracle whose idempotency keys must be preserved (or zero)
  constructor(
    address admin,
    address hub,
    address oldOracle
  ) EIP712("RelayOracle", "2") {
    if (admin == address(0) || hub == address(0)) {
      revert ZeroAddress();
    }
    // oldOracle is immutable and gates every execution — reject a bad one at deploy.
    if (oldOracle != address(0)) {
      // codeless target won't trigger the catch below, so reject it explicitly
      if (oldOracle.code.length == 0) {
        revert InvalidOldOracle(oldOracle);
      }
      try RelayOracle(oldOracle).isExecuted(bytes32(0)) returns (bool) {
        // ok
      } catch {
        revert InvalidOldOracle(oldOracle);
      }
      // require the same hub: env-independent keys let a foreign-env oldOracle skip executions
      if (address(RelayOracle(oldOracle).HUB()) != hub) {
        revert OldOracleHubMismatch(oldOracle);
      }
    }

    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    HUB = RelayHub(hub);
    OLD_ORACLE = RelayOracle(oldOracle);
  }

  // Public methods

  /// @notice Execute actions
  /// @param executions The actions to execute
  /// @param oracle The oracle address that signed all executions
  /// @param signatures The oracle signatures
  function executeMultiple(
    Execution[] calldata executions,
    address oracle,
    bytes[] calldata signatures
  ) external {
    uint256 executionsLength = executions.length;
    if (executionsLength != signatures.length) {
      revert LengthMismatch();
    }
    for (uint256 i; i < executionsLength; i++) {
      // skip if already executed (this contract or the old oracle)
      if (_isExecuted(executions[i].idempotencyKey)) {
        continue;
      }

      try this.execute(executions[i], oracle, signatures[i]) {
        // Execution succeeded
      } catch {
        // if execution failed, emit the failure and continue with the next
        emit ExecutionFailed(
          executions[i].idempotencyKey,
          executions[i].actions
        );
      }
    }
  }

  /// @notice Execute a single set of actions
  /// @param execution The actions to execute
  /// @param oracle The oracle address that signed the execution
  /// @param signature The oracle signature (ECDSA or EIP-1271)
  function execute(
    Execution calldata execution,
    address oracle,
    bytes calldata signature
  ) external {
    // Error if the idempotency key is marked as executed (this contract or the old oracle)
    if (_isExecuted(execution.idempotencyKey)) {
      revert AlreadyExecuted(execution.idempotencyKey);
    }
    _execute(execution, oracle, signature);
  }

  // Admin methods

  /// @notice Sets the fast-mint rate limiter
  /// @param newRateLimiter The rate limiter address (zero disables fast minting)
  function setRateLimiter(
    address newRateLimiter
  ) external onlyRole(ADMIN_ROLE) {
    rateLimiter = RelayFastRateLimiter(newRateLimiter);
    emit RateLimiterSet(newRateLimiter);
  }

  // Internal methods

  /// @notice Whether an idempotency key has already been executed by this contract or the old oracle
  /// @param idempotencyKey The execution idempotency key
  /// @return executed True if the key was executed here or on the old oracle
  function _isExecuted(
    bytes32 idempotencyKey
  ) internal view returns (bool executed) {
    if (isExecuted[idempotencyKey]) {
      return true;
    }
    // slither-disable-next-line calls-loop
    if (
      address(OLD_ORACLE) != address(0) && OLD_ORACLE.isExecuted(idempotencyKey)
    ) {
      return true;
    }
    return false;
  }

  /// @notice Executes a single action based on its encoded type and data.
  /// @param action The ABI-encoded action, with the first byte specifying the action type.
  /// @param idempotencyKey The execution's idempotency key (emitted in the FastMint event)
  function _executeAction(
    bytes memory action,
    bytes32 idempotencyKey
  ) internal virtual {
    // Extract the action type from the first byte of the encoded action data
    uint8 actionType = abi.decode(action, (uint8));

    if (actionType == uint8(ActionType.MINT)) {
      (, address hubToAddress, uint256 hubTokenId, uint256 amount) = abi.decode(
        action,
        (uint8, address, uint256, uint256)
      );
      // slither-disable-next-line unused-return,calls-loop
      HUB.mint(hubToAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.BURN)) {
      (, address hubFromAddress, uint256 hubTokenId, uint256 amount) = abi
        .decode(action, (uint8, address, uint256, uint256));

      // slither-disable-next-line unused-return,calls-loop
      HUB.burn(hubFromAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.TRANSFER)) {
      (
        ,
        address hubFromAddress,
        address hubToAddress,
        uint256 hubTokenId,
        uint256 amount
      ) = abi.decode(action, (uint8, address, address, uint256, uint256));

      // slither-disable-next-line unused-return,calls-loop
      HUB.transferFrom(hubFromAddress, hubToAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.FAST_MINT)) {
      _executeFastMint(action, idempotencyKey);
    } else {
      revert InvalidActionType(actionType);
    }
  }

  /// @notice Executes a `FAST_MINT`: rate-limit the full at-risk USD value, then split the gross
  ///         deposit and mint both parts — the fee to the fee recipient and the net amount to the
  ///         recipient.
  /// @dev Carries the hub token id (both legs mint it directly) plus the origin `chainId` (the
  ///      limiter's per-chain bucket key) and the off-chain-priced `usdValue` the attesting oracle
  ///      computed. It consumes that full `usdValue` (the at-risk value of the gross deposit) before
  ///      minting, so
  ///      a limiter rejection reverts the whole execution → nothing minted, key not consumed → the
  ///      deposit can be re-attested as slow. No per-deposit state is written: the recipient holds
  ///      exactly the net amount, which is the attested deposit amount settlement uses.
  /// @param action The ABI-encoded FAST_MINT action
  /// @param idempotencyKey The execution's idempotency key (emitted in the FastMint event)
  function _executeFastMint(
    bytes memory action,
    bytes32 idempotencyKey
  ) internal {
    (
      ,
      address hubToAddress,
      uint256 hubTokenId,
      string memory chainId, // the rate limiter's per-chain bucket key
      uint256 amount,
      uint256 feeBps,
      address feeRecipient,
      uint256 usdValue
    ) = abi.decode(
        action,
        (uint8, address, uint256, string, uint256, uint256, address, uint256)
      );

    if (feeBps > BPS_DENOMINATOR) {
      revert InvalidFeeBps(feeBps);
    }

    // Fee is a fraction of the deposit amount: fee = amount * feeBps / BPS_DENOMINATOR; the net
    // amount is the remainder. Flooring the fee leaves no dust (feeAmount + netAmount == amount).
    uint256 feeAmount = FixedPointMathLib.fullMulDiv(
      amount,
      feeBps,
      BPS_DENOMINATOR
    );
    uint256 netAmount = amount - feeAmount;
    if (feeAmount != 0 && feeRecipient == address(0)) {
      revert InvalidFeeRecipient();
    }

    // Rate-limit the full at-risk USD value before minting. A false result (over budget / fast
    // unavailable / zero usdValue) reverts the whole execution → nothing minted, key not consumed →
    // re-attestable as slow. `executeMultiple` catches the revert and surfaces the selector via
    // ExecutionFailed. The oracle prices `usdValue` off-chain (it has chainId + currency there).
    RelayFastRateLimiter limiter = rateLimiter;
    if (address(limiter) == address(0)) {
      revert RateLimiterNotSet();
    }
    // slither-disable-next-line calls-loop
    if (!limiter.consume(chainId, usdValue)) {
      revert FastMintRejected();
    }

    if (feeAmount != 0) {
      // slither-disable-next-line unused-return,calls-loop
      HUB.mint(feeRecipient, hubTokenId, feeAmount);
    }
    if (netAmount != 0) {
      // slither-disable-next-line unused-return,calls-loop
      HUB.mint(hubToAddress, hubTokenId, netAmount);
    }

    emit FastMint(
      idempotencyKey,
      hubToAddress,
      hubTokenId,
      amount,
      feeBps,
      feeRecipient
    );
  }

  /// @notice Execute actions
  /// @param execution The actions to execute
  /// @param oracle The oracle address that signed the execution
  /// @param signature The oracle signature (ECDSA or EIP-1271)
  function _execute(
    Execution calldata execution,
    address oracle,
    bytes calldata signature
  ) internal {
    bytes32 idempotencyKey = execution.idempotencyKey;

    // Error if the oracle is not an authorized address
    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    // Verify the signature (supports both EOA and EIP-1271 contract signatures)
    bytes32 digest = _hashExecution(execution);
    if (!oracle.isValidSignatureNow(digest, signature)) {
      revert InvalidSignature(oracle);
    }

    // Mark the idempotency key as executed
    isExecuted[idempotencyKey] = true;

    bytes[] calldata actions = execution.actions;
    unchecked {
      uint256 actionsLength = actions.length;
      for (uint256 i; i < actionsLength; i++) {
        bytes calldata action = actions[i];
        _executeAction(action, idempotencyKey);
      }
    }

    emit Executed(idempotencyKey, actions);
  }

  /// @notice Hash an execution
  /// @param execution The execution to hash
  /// @return result The hash of the signature
  function _hashExecution(
    Execution calldata execution
  ) internal view returns (bytes32 result) {
    uint256 actionsLength = execution.actions.length;

    // Initialize the array of action hashes
    bytes32[] memory actionHashes = new bytes32[](actionsLength);

    // Iterate over the underlying actions and hash them
    unchecked {
      for (uint256 i = 0; i < actionsLength; i++) {
        actionHashes[i] = keccak256(execution.actions[i]);
      }
    }

    // Get the struct hash
    bytes32 structHash = keccak256(
      abi.encode(
        _EXECUTION_TYPEHASH,
        execution.idempotencyKey,
        keccak256(abi.encodePacked(actionHashes))
      )
    );

    // Get the EIP712 hash
    result = _hashTypedDataV4(structHash);
  }
}
