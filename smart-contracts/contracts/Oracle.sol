// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {Hub} from "./Hub.sol";
import {Utils} from "./Utils.sol";

/// @title Oracle
/// @author Relay Protocol
/// @notice Oracle contract
contract Oracle is AccessControl, EIP712 {
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

  // Errors

  error AlreadyExecuted(bytes32 idempotencyKey);
  error InvalidSignature();
  error UnauthorizedOracle(address oracle);

  // Roles

  /// @notice Admin role
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice Hub contract
  Hub public immutable HUB;

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
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    HUB = Hub(hub);
  }

  // Public methods

  /// @notice Execute actions
  /// @param execution The actions to execute
  /// @param oracle The signing oracle
  /// @param signature The oracle signature
  function execute(
    Execution calldata execution,
    address oracle,
    bytes calldata signature
  ) external {
    // Error if the oracle is not an authorized address
    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    bytes32 idempotencyKey = execution.idempotencyKey;

    // Error if the idempotency key is marked as executed
    if (isExecuted[idempotencyKey]) {
      revert AlreadyExecuted(idempotencyKey);
    }

    // Mark the idempotency key as executed
    isExecuted[idempotencyKey] = true;

    // Verify the oracle signature
    if (!oracle.isValidSignatureNow(_hashExecution(execution), signature)) {
      revert InvalidSignature();
    }

    bytes[] calldata actions = execution.actions;
    unchecked {
      uint256 actionsLength = actions.length;
      for (uint256 i; i < actionsLength; i++) {
        bytes calldata action = actions[i];

        // Extract the action type from the first byte of the encoded action data
        uint8 actionType = abi.decode(action, (uint8));

        if (ActionType(actionType) == ActionType.MINT) {
          (
            ,
            string memory currencyVmType,
            uint256 currencyChainId,
            string memory currency,
            string memory toVmType,
            uint256 toChainId,
            string memory to,
            uint256 amount
          ) = abi.decode(
              action,
              (uint8, string, uint256, string, string, uint256, string, uint256)
            );

          uint256 tokenId = Utils.generateTokenId(
            currencyVmType,
            currencyChainId,
            currency
          );
          address toAddress = Utils.generateAddress(toVmType, toChainId, to);

          HUB.mint(toAddress, tokenId, amount);
        } else if (ActionType(actionType) == ActionType.BURN) {
          (
            ,
            string memory currencyVmType,
            uint256 currencyChainId,
            string memory currency,
            string memory fromVmType,
            uint256 fromChainId,
            string memory from,
            uint256 amount
          ) = abi.decode(
              action,
              (uint8, string, uint256, string, string, uint256, string, uint256)
            );

          uint256 tokenId = Utils.generateTokenId(
            currencyVmType,
            currencyChainId,
            currency
          );
          address fromAddress = Utils.generateAddress(
            fromVmType,
            fromChainId,
            from
          );

          uint256 amountToBurn = amount == type(uint256).max
            ? HUB.balanceOf(fromAddress, tokenId)
            : amount;

          HUB.burn(fromAddress, tokenId, amountToBurn);
        } else if (ActionType(actionType) == ActionType.TRANSFER) {
          (
            ,
            string memory currencyVmType,
            uint256 currencyChainId,
            string memory currency,
            string memory fromVmType,
            uint256 fromChainId,
            string memory from,
            string memory toVmType,
            uint256 toChainId,
            string memory to,
            uint256 amount
          ) = abi.decode(
              action,
              (
                uint8,
                string,
                uint256,
                string,
                string,
                uint256,
                string,
                string,
                uint256,
                string,
                uint256
              )
            );

          uint256 tokenId = Utils.generateTokenId(
            currencyVmType,
            currencyChainId,
            currency
          );
          address fromAddress = Utils.generateAddress(
            fromVmType,
            fromChainId,
            from
          );
          address toAddress = Utils.generateAddress(toVmType, toChainId, to);

          uint256 amountToTransfer = amount == type(uint256).max
            ? HUB.balanceOf(fromAddress, tokenId)
            : amount;

          HUB.transferFrom(fromAddress, toAddress, tokenId, amountToTransfer);
        }
      }
    }

    emit Executed(idempotencyKey, actions);
  }

  // Internal methods

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
