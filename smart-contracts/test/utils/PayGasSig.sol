// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Eip712} from "./Eip712.sol";
import {RelayAllocator} from "../../contracts/RelayAllocator.sol";
import {WithdrawGasPayer} from "../../contracts/WithdrawGasPayer.sol";

/// @notice Helpers for producing the EIP-712 PayGas oracle signatures the
/// WithdrawGasPayer verifies.
library PayGasSig {
  /// @notice Computes the PayGas struct hash for a withdraw request
  function structHash(
    WithdrawGasPayer gasPayer,
    RelayAllocator.WithdrawRequest memory request,
    bytes memory feeCurrency,
    uint256 feeAmount
  ) internal view returns (bytes32) {
    return
      keccak256(
        abi.encode(
          gasPayer.PAY_GAS_TYPEHASH(),
          keccak256(bytes(request.chainId)),
          keccak256(request.depository),
          keccak256(request.currency),
          request.amount,
          keccak256(bytes(request.spenderChainId)),
          keccak256(request.spender),
          keccak256(request.receiver),
          keccak256(request.data),
          request.nonce,
          keccak256(feeCurrency),
          feeAmount
        )
      );
  }

  /// @notice Computes the EIP-712 digest the oracle signs for a gas payment
  function digest(
    WithdrawGasPayer gasPayer,
    RelayAllocator.WithdrawRequest memory request,
    bytes memory feeCurrency,
    uint256 feeAmount
  ) internal view returns (bytes32) {
    return
      Eip712.digest(
        _gasPayerDomainSeparator(gasPayer),
        structHash(gasPayer, request, feeCurrency, feeAmount)
      );
  }

  /// @notice Signs the PayGas digest with the given oracle key
  function sign(
    uint256 oraclePk,
    WithdrawGasPayer gasPayer,
    RelayAllocator.WithdrawRequest memory request,
    bytes memory feeCurrency,
    uint256 feeAmount
  ) internal view returns (bytes memory) {
    return
      Eip712.sign(
        oraclePk,
        _gasPayerDomainSeparator(gasPayer),
        structHash(gasPayer, request, feeCurrency, feeAmount)
      );
  }

  function _gasPayerDomainSeparator(
    WithdrawGasPayer gasPayer
  ) private view returns (bytes32) {
    return
      Eip712.domainSeparator(
        gasPayer.SIGNING_DOMAIN(),
        gasPayer.SIGNATURE_VERSION(),
        block.chainid,
        address(gasPayer)
      );
  }
}
