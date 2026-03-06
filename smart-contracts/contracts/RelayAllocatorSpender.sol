// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {RelayAllocator, GasSettings} from "./RelayAllocator.sol";

/// @title RelayAllocatorSpender
/// @author Relay Protocol
/// @notice Gates RelayAllocator.signWithdrawPayloadHash behind oracle EIP-712 signature verification
contract RelayAllocatorSpender is AccessControl, EIP712 {
  using SignatureChecker for address;

  // Roles

  /// @notice Admin role
  bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

  /// @notice Oracle role
  bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

  // Constants

  /// @notice The type hash for SubmitWithdrawRequest (matches RelayAllocator)
  bytes32 public constant PAYLOAD_TYPEHASH =
    keccak256(
      "SubmitWithdrawRequest(uint256 chainId,string depository,string currency,uint256 amount,address spender,string receiver,bytes data,bytes32 nonce)"
    );

  /// @notice The RelayAllocator contract
  RelayAllocator public immutable ALLOCATOR;

  // Errors
  error UnauthorizedOracle(address oracle);
  error InvalidOracleSignature(address oracle);

  /// @notice Constructor
  /// @param admin The admin of the contract
  /// @param allocator The RelayAllocator contract address
  constructor(
    address admin,
    address allocator
  ) EIP712("RelayAllocatorSpender", "1") {
    _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    _setRoleAdmin(ORACLE_ROLE, ADMIN_ROLE);
    _grantRole(ADMIN_ROLE, admin);

    ALLOCATOR = RelayAllocator(allocator);
  }

  /// @notice Signs a withdraw payload hash on the allocator after verifying oracle signature
  /// @param params The withdraw request parameters
  /// @param gasSettings Gas settings for NEAR operations
  /// @param hashIndex Index of the hash to sign
  /// @param oracle The oracle address that signed the request
  /// @param oracleSignature The oracle's EIP-712 signature
  function signWithdrawPayloadHash(
    RelayAllocator.SubmitWithdrawRequest calldata params,
    GasSettings memory gasSettings,
    uint32 hashIndex,
    address oracle,
    bytes calldata oracleSignature
  ) external {
    if (!hasRole(ORACLE_ROLE, oracle)) {
      revert UnauthorizedOracle(oracle);
    }

    bytes32 digest = _hashTypedDataV4(
      keccak256(
        abi.encode(
          PAYLOAD_TYPEHASH,
          params.chainId,
          keccak256(bytes(params.depository)),
          keccak256(bytes(params.currency)),
          params.amount,
          params.spender,
          keccak256(bytes(params.receiver)),
          keccak256(params.data),
          params.nonce
        )
      )
    );

    if (!oracle.isValidSignatureNow(digest, oracleSignature)) {
      revert InvalidOracleSignature(oracle);
    }

    ALLOCATOR.signWithdrawPayloadHash(params, "", gasSettings, hashIndex);
  }
}
