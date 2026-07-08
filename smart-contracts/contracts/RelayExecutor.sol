// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {
  ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
  SignatureChecker
} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {RelayAllocator} from "./RelayAllocator.sol";
import {RelayCallExecutor} from "./RelayCallExecutor.sol";
import {RelayHub} from "./RelayHub.sol";
import {Utils} from "./Utils.sol";

/// @title RelayExecutor
/// @author Relay Protocol
/// @notice Verifies oracle-authorized withdrawals and executes caller-supplied calls
contract RelayExecutor is AccessControl, EIP712, ReentrancyGuard {
  using SignatureChecker for address;

  // Structs

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
  }

  // Events

  /// @notice Emitted after an execute and withdraw request is executed and submitted to the allocator
  event Executed(
    address indexed orderAddress,
    uint256 indexed tokenIn,
    uint256 indexed tokenOut,
    uint256 amountIn,
    uint256 amountOut,
    bytes32 withdrawRequestHash
  );

  // Errors

  /// @notice Thrown when the supplied oracle does not have ORACLE_ROLE
  error UnauthorizedOracle(address oracle);

  /// @notice Thrown when the supplied signature does not match the oracle
  error InvalidSignature(address oracle);

  /// @notice Thrown when the order address does not hold any source currency balance
  error EmptyOrderBalance(address orderAddress, uint256 tokenId);

  /// @notice Thrown when a RelayHub transfer unexpectedly returns false
  error HubTransferFailed(
    address from,
    address to,
    uint256 tokenId,
    uint256 amount
  );

  /// @notice Thrown when the final withdrawal currency balance is below the signed minimum
  error InsufficientMinimumAmount(
    uint256 tokenId,
    uint256 balance,
    uint256 outAmountMinimum
  );

  /// @notice Thrown when an oracle authorization has already been consumed
  error RequestAlreadyExecuted(bytes32 digest);

  // Roles

  /// @notice Admin role
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice Hub contract
  RelayHub public immutable HUB;

  /// @notice Allocator contract
  RelayAllocator public immutable ALLOCATOR;

  /// @notice Sandbox contract that runs untrusted, caller-supplied calls
  RelayCallExecutor public immutable CALL_EXECUTOR;

  /// @notice Spender chain id used for allocator withdrawals initiated by this contract
  string private constant _SPENDER_CHAIN_ID = "relay";

  bytes32 private constant _EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH =
    keccak256(
      "ExecuteAndWithdrawRequest(string inChainId,bytes inCurrency,string outChainId,bytes outCurrency,uint256 outAmountMinimum,bytes depository,address orderAddress,bytes receiver,bytes data,Fee[] fees,bytes32 nonce)Fee(address recipient,uint256 amount)"
    );

  bytes32 private constant _FEE_TYPEHASH =
    keccak256("Fee(address recipient,uint256 amount)");

  // Fields

  /// @notice Mapping of allocator withdraw request hash to source order address
  mapping(bytes32 => address) public orderAddressByWithdrawRequestHash;

  /// @notice Tracks consumed oracle authorizations keyed by their EIP-712 digest
  /// @dev The digest commits to request.nonce and orderAddress, making each
  ///      oracle authorization single-use regardless of the caller-supplied
  ///      calls array or the resulting withdrawal amount.
  mapping(bytes32 => bool) public usedRequests;

  /// @notice Tracks order addresses that have already been charged fees
  mapping(address => bool) public feesChargedByOrderAddress;

  // Constructor

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param hub The hub contract
  /// @param allocator The allocator contract
  constructor(
    address admin,
    address hub,
    address allocator
  ) EIP712("RelayExecutor", "1") {
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    HUB = RelayHub(hub);
    ALLOCATOR = RelayAllocator(allocator);
    CALL_EXECUTOR = new RelayCallExecutor(hub, address(this));
  }

  // Public methods

  /// @notice Execute a signed execute and withdraw request
  /// @dev Withdraw amount is the post-call Hub balance of the currency derived from outChainId/outCurrency.
  /// @param request Oracle-signed execute and withdraw request
  /// @param calls Unsigned calls to execute after pulling order funds
  /// @param oracle Oracle address that signed the request
  /// @param signature Oracle signature (ECDSA or EIP-1271)
  /// @return withdrawRequestHash Hash of the allocator withdrawal request
  function execute(
    ExecuteAndWithdrawRequest calldata request,
    RelayCallExecutor.Call[] calldata calls,
    address oracle,
    bytes calldata signature
  ) external nonReentrant returns (bytes32 withdrawRequestHash) {
    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    bytes32 digest = _executeAndWithdrawRequestDigest(request);

    if (usedRequests[digest]) {
      revert RequestAlreadyExecuted(digest);
    }
    usedRequests[digest] = true;

    if (!oracle.isValidSignatureNow(digest, signature)) {
      revert InvalidSignature(oracle);
    }

    uint256 tokenInId = Utils.generateTokenId(
      request.inChainId,
      request.inCurrency
    );
    uint256 orderBalance = _pullOrderFunds(request.orderAddress, tokenInId);

    _chargeFees(request.orderAddress, tokenInId, request.fees);

    uint256 tokenOutId = Utils.generateTokenId(
      request.outChainId,
      request.outCurrency
    );

    _runCalls(calls, tokenInId, tokenOutId);

    uint256 withdrawAmount = HUB.balanceOf(address(this), tokenOutId);
    if (withdrawAmount < request.outAmountMinimum) {
      revert InsufficientMinimumAmount(
        tokenOutId,
        withdrawAmount,
        request.outAmountMinimum
      );
    }

    _fundSpenderAlias(tokenOutId, withdrawAmount);

    withdrawRequestHash = ALLOCATOR.submitWithdrawRequest(
      RelayAllocator.WithdrawRequest({
        chainId: request.outChainId,
        depository: request.depository,
        currency: request.outCurrency,
        amount: withdrawAmount,
        spenderChainId: _SPENDER_CHAIN_ID,
        spender: abi.encodePacked(address(this)),
        receiver: request.receiver,
        data: request.data,
        nonce: request.nonce
      })
    );
    orderAddressByWithdrawRequestHash[withdrawRequestHash] = request
      .orderAddress;

    emit Executed(
      request.orderAddress,
      tokenInId,
      tokenOutId,
      orderBalance,
      withdrawAmount,
      withdrawRequestHash
    );
  }

  // Internal methods

  /// @notice Pushes the pulled input into the sandbox, runs the untrusted calls
  ///         there, then sweeps the input and output currencies back
  /// @dev Running the caller-supplied calls in an isolated, privilege-less
  ///      sandbox that only holds this order's input funds bounds the impact of
  ///      a malicious call to the current order. If the input is diverted the
  ///      output falls below the signed minimum and the transaction reverts.
  function _runCalls(
    RelayCallExecutor.Call[] calldata calls,
    uint256 tokenInId,
    uint256 tokenOutId
  ) internal {
    uint256 netInput = HUB.balanceOf(address(this), tokenInId);
    if (netInput != 0) {
      if (!HUB.transfer(address(CALL_EXECUTOR), tokenInId, netInput)) {
        revert HubTransferFailed(
          address(this),
          address(CALL_EXECUTOR),
          tokenInId,
          netInput
        );
      }
    }

    uint256[] memory sweepTokenIds = new uint256[](2);
    sweepTokenIds[0] = tokenInId;
    sweepTokenIds[1] = tokenOutId;

    CALL_EXECUTOR.run(calls, sweepTokenIds);
  }

  /// @notice Pulls the entire source currency balance from an order address
  /// @return orderBalance Amount transferred from the order address
  function _pullOrderFunds(
    address orderAddress,
    uint256 tokenId
  ) internal returns (uint256 orderBalance) {
    orderBalance = HUB.balanceOf(orderAddress, tokenId);
    if (orderBalance == 0) {
      revert EmptyOrderBalance(orderAddress, tokenId);
    }

    if (!HUB.transferFrom(orderAddress, address(this), tokenId, orderBalance)) {
      revert HubTransferFailed(
        orderAddress,
        address(this),
        tokenId,
        orderBalance
      );
    }
  }

  /// @notice Charges fees in the input currency from the pulled order funds
  /// @dev Fees are charged at most once per order address. Reverts on
  ///      insufficient balance if the fees exceed the pulled funds.
  function _chargeFees(
    address orderAddress,
    uint256 tokenId,
    Fee[] calldata fees
  ) internal {
    if (feesChargedByOrderAddress[orderAddress]) {
      return;
    }
    feesChargedByOrderAddress[orderAddress] = true;

    uint256 feesLength = fees.length;
    for (uint256 i; i < feesLength; ++i) {
      Fee calldata fee = fees[i];
      // slither-disable-next-line calls-loop
      if (!HUB.transfer(fee.recipient, tokenId, fee.amount)) {
        revert HubTransferFailed(
          address(this),
          fee.recipient,
          tokenId,
          fee.amount
        );
      }
    }
  }

  /// @notice Moves the withdrawal amount into the allocator spender alias
  function _fundSpenderAlias(uint256 tokenId, uint256 withdrawAmount) internal {
    address spenderAlias = Utils.generateAddress(
      _SPENDER_CHAIN_ID,
      abi.encodePacked(address(this))
    );
    if (!HUB.transfer(spenderAlias, tokenId, withdrawAmount)) {
      revert HubTransferFailed(
        address(this),
        spenderAlias,
        tokenId,
        withdrawAmount
      );
    }
  }

  /// @notice Computes the EIP-712 digest for an execute and withdraw request
  /// @return digest EIP-712 digest signed by the oracle
  function _executeAndWithdrawRequestDigest(
    ExecuteAndWithdrawRequest calldata request
  ) internal view returns (bytes32 digest) {
    bytes32 structHash = keccak256(
      abi.encode(
        _EXECUTE_AND_WITHDRAW_REQUEST_TYPEHASH,
        keccak256(bytes(request.inChainId)),
        keccak256(request.inCurrency),
        keccak256(bytes(request.outChainId)),
        keccak256(request.outCurrency),
        request.outAmountMinimum,
        keccak256(request.depository),
        request.orderAddress,
        keccak256(request.receiver),
        keccak256(request.data),
        _hashFees(request.fees),
        request.nonce
      )
    );

    digest = _hashTypedDataV4(structHash);
  }

  /// @notice Computes the EIP-712 hash of the fees array
  /// @return hash Hash of the encoded fees array
  function _hashFees(Fee[] calldata fees) internal pure returns (bytes32 hash) {
    uint256 feesLength = fees.length;
    bytes32[] memory feeHashes = new bytes32[](feesLength);
    for (uint256 i; i < feesLength; ++i) {
      feeHashes[i] = keccak256(
        abi.encode(_FEE_TYPEHASH, fees[i].recipient, fees[i].amount)
      );
    }

    hash = keccak256(abi.encodePacked(feeHashes));
  }
}
