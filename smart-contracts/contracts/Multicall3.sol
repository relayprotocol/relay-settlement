// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Multicall3
/// @author Michael Elliot
/// @author Joshua Levine
/// @author Nick Johnson
/// @author Andreas Bigger
/// @author Matt Solomon
/// @notice Aggregates multiple calls and returns their results.
/// @dev Backwards-compatible with Multicall and Multicall2. Unlike the
/// canonical Multicall3 implementation, a required call that fails reverts
/// with the call's original return data instead of replacing it with a generic
/// `Multicall3: call failed` error.
contract Multicall3 {
  /// @notice A call that must succeed.
  /// @param target Contract to call
  /// @param callData Calldata to send
  struct Call {
    address target;
    bytes callData;
  }

  /// @notice A call with configurable failure handling.
  /// @param target Contract to call
  /// @param allowFailure Whether a failure may be returned instead of reverting
  /// @param callData Calldata to send
  struct Call3 {
    address target;
    bool allowFailure;
    bytes callData;
  }

  /// @notice A call with configurable failure handling and native value.
  /// @param target Contract to call
  /// @param allowFailure Whether a failure may be returned instead of reverting
  /// @param value Native value to send
  /// @param callData Calldata to send
  struct Call3Value {
    address target;
    bool allowFailure;
    uint256 value;
    bytes callData;
  }

  /// @notice The result of one call.
  /// @param success Whether the call succeeded
  /// @param returnData Data returned by the call
  struct Result {
    bool success;
    bytes returnData;
  }

  /// @notice Backwards-compatible call aggregation with Multicall.
  /// @param calls Calls to execute
  /// @return blockNumber Block number where the calls were executed
  /// @return returnData Data returned by each call
  function aggregate(
    Call[] calldata calls
  ) external payable returns (uint256 blockNumber, bytes[] memory returnData) {
    blockNumber = block.number;
    uint256 length = calls.length;
    returnData = new bytes[](length);

    for (uint256 i; i < length; ++i) {
      bool success;
      (success, returnData[i]) = calls[i].target.call(calls[i].callData);
      if (!success) {
        _revert(returnData[i]);
      }
    }
  }

  /// @notice Backwards-compatible call aggregation with Multicall2.
  /// @param requireSuccess Whether every call must succeed
  /// @param calls Calls to execute
  /// @return returnData Results returned by each call
  function tryAggregate(
    bool requireSuccess,
    Call[] calldata calls
  ) public payable returns (Result[] memory returnData) {
    uint256 length = calls.length;
    returnData = new Result[](length);

    for (uint256 i; i < length; ++i) {
      Result memory result = returnData[i];
      (result.success, result.returnData) = calls[i].target.call(
        calls[i].callData
      );
      if (requireSuccess && !result.success) {
        _revert(result.returnData);
      }
    }
  }

  /// @notice Executes calls and returns block metadata and their results.
  /// @param requireSuccess Whether every call must succeed
  /// @param calls Calls to execute
  /// @return blockNumber Block number where the calls were executed
  /// @return blockHash Hash of the block where the calls were executed
  /// @return returnData Results returned by each call
  function tryBlockAndAggregate(
    bool requireSuccess,
    Call[] calldata calls
  )
    public
    payable
    returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
  {
    blockNumber = block.number;
    blockHash = blockhash(block.number);
    returnData = tryAggregate(requireSuccess, calls);
  }

  /// @notice Executes required calls and returns block metadata and their results.
  /// @param calls Calls to execute
  /// @return blockNumber Block number where the calls were executed
  /// @return blockHash Hash of the block where the calls were executed
  /// @return returnData Results returned by each call
  function blockAndAggregate(
    Call[] calldata calls
  )
    external
    payable
    returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
  {
    return tryBlockAndAggregate(true, calls);
  }

  /// @notice Executes calls with configurable failure handling.
  /// @param calls Calls to execute
  /// @return returnData Results returned by each call
  function aggregate3(
    Call3[] calldata calls
  ) external payable returns (Result[] memory returnData) {
    uint256 length = calls.length;
    returnData = new Result[](length);

    for (uint256 i; i < length; ++i) {
      Result memory result = returnData[i];
      (result.success, result.returnData) = calls[i].target.call(
        calls[i].callData
      );
      if (!calls[i].allowFailure && !result.success) {
        _revert(result.returnData);
      }
    }
  }

  /// @notice Executes calls with configurable failure handling and native value.
  /// @param calls Calls to execute
  /// @return returnData Results returned by each call
  function aggregate3Value(
    Call3Value[] calldata calls
  ) external payable returns (Result[] memory returnData) {
    uint256 valueAccumulator;
    uint256 length = calls.length;
    returnData = new Result[](length);

    for (uint256 i; i < length; ++i) {
      Result memory result = returnData[i];
      uint256 value = calls[i].value;
      valueAccumulator += value;
      // Every forwarded value is funded by this call's msg.value; the
      // post-loop invariant reverts all subcalls if the totals differ.
      // slither-disable-next-line arbitrary-send-eth
      (result.success, result.returnData) = calls[i].target.call{value: value}(
        calls[i].callData
      );
      if (!calls[i].allowFailure && !result.success) {
        _revert(result.returnData);
      }
    }

    // Preserve the canonical Multicall3 error for backwards compatibility.
    // solhint-disable-next-line gas-custom-errors
    require(msg.value == valueAccumulator, "Multicall3: value mismatch");
  }

  /// @notice Returns the hash for a block number.
  /// @param blockNumber Block number to query
  /// @return blockHash Hash of `blockNumber`
  function getBlockHash(
    uint256 blockNumber
  ) external view returns (bytes32 blockHash) {
    blockHash = blockhash(blockNumber);
  }

  /// @notice Returns the current block number.
  /// @return blockNumber Current block number
  function getBlockNumber() external view returns (uint256 blockNumber) {
    blockNumber = block.number;
  }

  /// @notice Returns the current block's beneficiary.
  /// @return coinbase Current block beneficiary
  function getCurrentBlockCoinbase() external view returns (address coinbase) {
    coinbase = block.coinbase;
  }

  /// @notice Returns the current block's prevrandao value.
  /// @dev Retains the canonical Multicall3 function name for compatibility.
  /// @return difficulty Current block prevrandao value
  function getCurrentBlockDifficulty()
    external
    view
    returns (uint256 difficulty)
  {
    difficulty = block.prevrandao;
  }

  /// @notice Returns the current block gas limit.
  /// @return gaslimit Current block gas limit
  function getCurrentBlockGasLimit() external view returns (uint256 gaslimit) {
    gaslimit = block.gaslimit;
  }

  /// @notice Returns the current block timestamp.
  /// @return timestamp Current block timestamp
  function getCurrentBlockTimestamp()
    external
    view
    returns (uint256 timestamp)
  {
    timestamp = block.timestamp;
  }

  /// @notice Returns an account's native balance.
  /// @param account Account to query
  /// @return balance Native balance of `account`
  function getEthBalance(
    address account
  ) external view returns (uint256 balance) {
    balance = account.balance;
  }

  /// @notice Returns the previous block's hash.
  /// @return blockHash Previous block hash
  function getLastBlockHash() external view returns (bytes32 blockHash) {
    blockHash = blockhash(block.number - 1);
  }

  /// @notice Returns the current block's base fee.
  /// @return basefee Current block base fee
  function getBasefee() external view returns (uint256 basefee) {
    basefee = block.basefee;
  }

  /// @notice Returns the current chain ID.
  /// @return chainId Current chain ID
  function getChainId() external view returns (uint256 chainId) {
    chainId = block.chainid;
  }

  /// @notice Reverts with the exact data returned by a failed inner call.
  /// @param returnData Revert data to bubble
  function _revert(bytes memory returnData) private pure {
    // Assembly is required to bubble arbitrary revert data without wrapping it.
    // solhint-disable-next-line no-inline-assembly
    assembly ("memory-safe") {
      revert(add(returnData, 0x20), mload(returnData))
    }
  }
}
