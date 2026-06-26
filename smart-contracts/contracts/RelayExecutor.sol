// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {RelayAllocator} from "./RelayAllocator.sol";
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

  /// @notice Unsigned arbitrary call executed between funding and withdrawal
  /// @param to Call target
  /// @param data Calldata to pass to the target
  struct Call {
    address to;
    bytes data;
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

  /// @notice Thrown when an arbitrary call reverts
  error CallFailed(uint256 index, address target, bytes reason);

  /// @notice Thrown when the final withdrawal currency balance is below the signed minimum
  error InsufficientMinimumAmount(
    uint256 tokenId,
    uint256 balance,
    uint256 outAmountMinimum
  );

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
    Call[] calldata calls,
    address oracle,
    bytes calldata signature
  ) external nonReentrant returns (bytes32 withdrawRequestHash) {
    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    if (
      !oracle.isValidSignatureNow(
        _executeAndWithdrawRequestDigest(request),
        signature
      )
    ) {
      revert InvalidSignature(oracle);
    }

    uint256 tokenInId = Utils.generateTokenId(
      request.inChainId,
      request.inCurrency
    );
    uint256 orderBalance = _pullOrderFunds(request.orderAddress, tokenInId);

    _chargeFees(request.orderAddress, tokenInId, request.fees);

    _executeCalls(calls);

    uint256 tokenOutId = Utils.generateTokenId(
      request.outChainId,
      request.outCurrency
    );
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

  /// @notice Executes unsigned arbitrary calls
  function _executeCalls(Call[] calldata calls) internal {
    uint256 callsLength = calls.length;
    for (uint256 i; i < callsLength; ++i) {
      Call calldata call_ = calls[i];
      // slither-disable-next-line calls-loop
      (bool success, bytes memory result) = call_.to.call(call_.data);
      if (!success) {
        revert CallFailed(i, call_.to, result);
      }
    }
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
  function _hashFees(
    Fee[] calldata fees
  ) internal pure returns (bytes32 hash) {
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
