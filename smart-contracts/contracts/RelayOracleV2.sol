// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IFeeCalculator} from "./fee-calculators/IFeeCalculator.sol";
import {RelayHub} from "./RelayHub.sol";
import {RelayOracleIdempotencyStore} from "./RelayOracleIdempotencyStore.sol";
import {IRateLimiter} from "./rate-limiters/IRateLimiter.sol";

/// @title RelayOracleV2
/// @author Relay Protocol
/// @notice Oracle contract that adds the fast-finality `FAST_MINT` action on top of the
///         MINT / BURN / TRANSFER actions of `RelayOracle`. A fast deposit is minted in two
///         full deposited amount to the recipient, plus a fee transferred from the fee payer to the
///         fee recipient, after the at-risk amount clears the on-chain rate limiter.
/// @dev    Idempotency is checked against the shared idempotency store. Legacy oracle keys must be
///         configured as store sources rather than being checked directly by this contract.
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

  struct FeeResult {
    uint256 currency;
    uint256 amount;
    address recipient;
    address payer;
  }

  // Events

  /// @notice Emitted when actions were executed
  event Executed(bytes32 indexed idempotencyKey, bytes[] actions);

  /// @notice Emitted when an action failed to execute in a batch
  event ExecutionFailed(bytes32 indexed idempotencyKey, bytes[] actions);

  /// @notice Emitted when a rate limiter is added to the FAST_MINT allowlist
  event RateLimiterAdded(address indexed rateLimiter);
  /// @notice Emitted when a rate limiter is removed from the FAST_MINT allowlist
  event RateLimiterRemoved(address indexed rateLimiter);
  /// @notice Emitted when a fee calculator is added to the FAST_MINT allowlist
  event FeeCalculatorAdded(address indexed feeCalculator);
  /// @notice Emitted when a fee calculator is removed from the FAST_MINT allowlist
  event FeeCalculatorRemoved(address indexed feeCalculator);

  /// @notice Emitted on a FAST_MINT for observability. Not consumed by settlement: the recipient
  ///         holds the full attested deposit amount, and the fee is transferred from the fee payer in
  ///         the returned fee currency.
  event FastMint(
    bytes32 indexed idempotencyKey,
    address hubToAddress,
    uint256 hubTokenId,
    uint256 amount,
    uint256 feeCurrency,
    uint256 feeAmount,
    address feeRecipient,
    address feePayer
  );

  // Errors
  error ZeroAddress();
  error AlreadyExecuted(bytes32 idempotencyKey);
  error UnauthorizedOracle(address oracle);
  error InvalidSignature(address oracle);
  error InvalidActionType(uint8 actionType);
  error RateLimiterNotAllowed(address rateLimiter);
  error FeeCalculatorNotAllowed(address feeCalculator);
  error InvalidIdempotencyStore(address idempotencyStore);
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

  /// @notice Shared idempotency-key storage for this oracle generation and future migrations.
  RelayOracleIdempotencyStore public immutable IDEMPOTENCY_STORE;

  bytes32 private constant _EXECUTION_TYPEHASH =
    keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

  /// @notice Allowlist of rate limiters a `FAST_MINT` may invoke. The action names which limiter to
  ///         call; the admin adds/removes them, so a new limiter type needs no change here. An empty
  ///         allowlist — or naming a non-allowlisted limiter — fails closed.
  mapping(address => bool) public isRateLimiter;

  /// @notice Allowlist of fee calculators a `FAST_MINT` may invoke. A zero fee calculator skips fee
  ///         calculation; any non-zero calculator must be allowlisted.
  mapping(address => bool) public isFeeCalculator;

  // Constructor

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param hub The hub contract
  /// @param idempotencyStore Shared idempotency-key storage
  constructor(
    address admin,
    address hub,
    address idempotencyStore
  ) EIP712("RelayOracle", "2") {
    if (
      admin == address(0) || hub == address(0) || idempotencyStore == address(0)
    ) {
      revert ZeroAddress();
    }
    // idempotencyStore is immutable and gates every execution — reject a codeless address at deploy.
    if (idempotencyStore.code.length == 0) {
      revert InvalidIdempotencyStore(idempotencyStore);
    }
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    HUB = RelayHub(hub);
    IDEMPOTENCY_STORE = RelayOracleIdempotencyStore(idempotencyStore);
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
      // Error if the idempotency key is marked as executed
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
    // Error if the idempotency key is marked as executed
    if (_isExecuted(execution.idempotencyKey)) {
      revert AlreadyExecuted(execution.idempotencyKey);
    }
    _execute(execution, oracle, signature);
  }

  // Admin methods

  /// @notice Adds a rate limiter to the FAST_MINT allowlist
  /// @param rateLimiter The rate limiter address
  function addRateLimiter(address rateLimiter) external onlyRole(ADMIN_ROLE) {
    if (rateLimiter == address(0)) {
      revert ZeroAddress();
    }
    isRateLimiter[rateLimiter] = true;
    emit RateLimiterAdded(rateLimiter);
  }

  /// @notice Removes a rate limiter from the FAST_MINT allowlist
  /// @param rateLimiter The rate limiter address
  function removeRateLimiter(
    address rateLimiter
  ) external onlyRole(ADMIN_ROLE) {
    isRateLimiter[rateLimiter] = false;
    emit RateLimiterRemoved(rateLimiter);
  }

  /// @notice Adds a fee calculator to the FAST_MINT allowlist
  /// @param feeCalculator The fee calculator address
  function addFeeCalculator(
    address feeCalculator
  ) external onlyRole(ADMIN_ROLE) {
    if (feeCalculator == address(0)) {
      revert ZeroAddress();
    }
    isFeeCalculator[feeCalculator] = true;
    emit FeeCalculatorAdded(feeCalculator);
  }

  /// @notice Removes a fee calculator from the FAST_MINT allowlist
  /// @param feeCalculator The fee calculator address
  function removeFeeCalculator(
    address feeCalculator
  ) external onlyRole(ADMIN_ROLE) {
    isFeeCalculator[feeCalculator] = false;
    emit FeeCalculatorRemoved(feeCalculator);
  }

  /// @notice Whether an idempotency key has already been executed.
  /// @param idempotencyKey The execution idempotency key
  /// @return executed True if the key was executed through the shared store
  function isExecuted(
    bytes32 idempotencyKey
  ) public view returns (bool executed) {
    return _isExecuted(idempotencyKey);
  }

  // Internal methods

  /// @notice Whether an idempotency key has already been executed.
  /// @param idempotencyKey The execution idempotency key
  /// @return executed True if the key was executed through the shared store
  function _isExecuted(
    bytes32 idempotencyKey
  ) internal view returns (bool executed) {
    return IDEMPOTENCY_STORE.isExecuted(idempotencyKey);
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
      if (amount == 0) return;

      // slither-disable-next-line unused-return,calls-loop
      HUB.mint(hubToAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.BURN)) {
      (, address hubFromAddress, uint256 hubTokenId, uint256 amount) = abi
        .decode(action, (uint8, address, uint256, uint256));
      if (amount == 0) return;

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
      if (amount == 0) return;

      // slither-disable-next-line unused-return,calls-loop
      HUB.transferFrom(hubFromAddress, hubToAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.FAST_MINT)) {
      _executeFastMint(action, idempotencyKey);
    } else {
      revert InvalidActionType(actionType);
    }
  }

  /// @notice Executes a `FAST_MINT`: rate-limit the at-risk deposit amount, then mint the full
  ///         deposit amount to the recipient and transfer the fee from the fee payer.
  /// @dev Carries the mint params (`hubTo`, `hubTokenId`, `amount`), the `feeCalculator` to call
  ///      plus its opaque `feeCalculatorData`, and the `rateLimiter` to call plus its opaque
  ///      `rateLimiterData`. `hubTokenId` and `amount` are supplied directly and passed to both
  ///      pluggable modules. The allowlisted `rateLimiter` decodes `rateLimiterData` and rate-limits
  ///      before minting, so a rejection reverts the whole execution → nothing minted, key not
  ///      consumed → re-attestable as slow. A zero `feeCalculator` skips fee calculation and only
  ///      mints the full amount to the recipient. A zero `rateLimiter` skips rate limiting entirely
  ///      (no allowlist check, no `consume` call). No per-deposit state is written: the recipient
  ///      holds the full attested deposit amount, and fee accounting is emitted for observers.
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
      uint256 amount,
      address feeCalculator,
      bytes memory feeCalculatorData,
      address rateLimiter,
      bytes memory rateLimiterData
    ) = abi.decode(
        action,
        (uint8, address, uint256, uint256, address, bytes, address, bytes)
      );

    FeeResult memory fee;
    // Fee computation is delegated to the action-provided module so future fee changes do not need
    // to touch the oracle's execution and idempotency logic.
    if (feeCalculator != address(0)) {
      if (!isFeeCalculator[feeCalculator]) {
        revert FeeCalculatorNotAllowed(feeCalculator);
      }
      (fee.currency, fee.amount, fee.recipient, fee.payer) = IFeeCalculator(
        feeCalculator
      ).calculateFee(hubTokenId, amount, feeCalculatorData);
    }

    // Rate-limit via the allowlisted rateLimiter named in the action; it decodes `rateLimiterData`
    // itself, so a new rate limiter type needs no change here. A false result (over budget / zero
    // amount) reverts the whole execution → nothing minted, key not consumed → re-attestable as slow;
    // `executeMultiple` catches the revert and surfaces the selector via ExecutionFailed.
    //
    // A zero-address rateLimiter opts out of rate limiting entirely: no allowlist check and no
    // `consume` call are performed. This is only reachable when the oracle attests
    // `rateLimiter == address(0)`, so the rate-limit bypass is an explicit, per-deposit decision made
    // by the trusted oracle.
    if (rateLimiter != address(0)) {
      if (!isRateLimiter[rateLimiter]) {
        revert RateLimiterNotAllowed(rateLimiter);
      }
      // slither-disable-next-line calls-loop
      if (
        !IRateLimiter(rateLimiter).consume(hubTokenId, amount, rateLimiterData)
      ) {
        revert FastMintRejected();
      }
    }

    if (fee.amount != 0) {
      // slither-disable-next-line unused-return,calls-loop
      HUB.transferFrom(fee.payer, fee.recipient, fee.currency, fee.amount);
    }
    if (amount != 0) {
      // slither-disable-next-line unused-return,calls-loop
      HUB.mint(hubToAddress, hubTokenId, amount);
    }

    emit FastMint(
      idempotencyKey,
      hubToAddress,
      hubTokenId,
      amount,
      fee.currency,
      fee.amount,
      fee.recipient,
      fee.payer
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

    // Mark the idempotency key as executed. If a later action reverts, this external write rolls
    // back with the rest of the transaction.
    IDEMPOTENCY_STORE.markExecuted(idempotencyKey);

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
