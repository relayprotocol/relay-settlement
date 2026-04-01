// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {RelayHub} from "./RelayHub.sol";

/// @title RelayOracle
/// @author Relay Protocol
/// @notice Oracle contract
contract RelayOracle is AccessControl, EIP712 {
  using SignatureChecker for address;

  // Structs

  enum ActionType {
    MINT,
    BURN,
    TRANSFER
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

  // Errors
  error AlreadyExecuted(bytes32 idempotencyKey);
  error UnauthorizedOracle(address oracle);
  error InvalidSignature(address oracle);
  error InvalidActionType(uint8 actionType);

  // Roles

  /// @notice Admin role
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice Hub contract
  RelayHub public immutable HUB;

  bytes32 private constant _EXECUTION_TYPEHASH =
    keccak256("Execution(bytes32 idempotencyKey,bytes[] actions)");

  // Fields

  /// @notice Mapping of execution hash to execution status
  mapping(bytes32 => bool) public isExecuted;

  // Constructor

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param hub The hub contract
  constructor(address admin, address hub) EIP712("RelayOracle", "1") {
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    HUB = RelayHub(hub);
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
    for (uint256 i; i < executionsLength; i++) {
      // skip if already executed
      if (isExecuted[executions[i].idempotencyKey]) {
        continue;
      }

      try this.execute(executions[i], oracle, signatures[i]) {
        // Execution succeeded
      } catch {
        // if execution failed, throw event and continue with next
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
    if (isExecuted[execution.idempotencyKey]) {
      revert AlreadyExecuted(execution.idempotencyKey);
    }
    _execute(execution, oracle, signature);
  }

  // Internal methods

  /// @notice Executes a single action based on its encoded type and data.
  /// @param action The ABI-encoded action, with the first byte specifying the action type.
  function _executeAction(bytes memory action) internal virtual {
    // Extract the action type from the first byte of the encoded action data
    uint8 actionType = abi.decode(action, (uint8));

    if (actionType == uint8(ActionType.MINT)) {
      (, address hubToAddress, uint256 hubTokenId, uint256 amount) = abi.decode(
        action,
        (uint8, address, uint256, uint256)
      );
      HUB.mint(hubToAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.BURN)) {
      (, address hubFromAddress, uint256 hubTokenId, uint256 amount) = abi
        .decode(action, (uint8, address, uint256, uint256));

      HUB.burn(hubFromAddress, hubTokenId, amount);
    } else if (actionType == uint8(ActionType.TRANSFER)) {
      (
        ,
        address hubFromAddress,
        address hubToAddress,
        uint256 hubTokenId,
        uint256 amount
      ) = abi.decode(action, (uint8, address, address, uint256, uint256));

      HUB.transferFrom(hubFromAddress, hubToAddress, hubTokenId, amount);
    } else {
      revert InvalidActionType(actionType);
    }
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
        _executeAction(action);
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
