// SPDX-License-Identifier: UNLICENSED
// ABOUTME: Test harness exposing BitcoinDepositAddress validation logic without Aurora precompiles.
// ABOUTME: Used by test/BitcoinDepositAddressBuilder/sweepStateMachine.ts.
pragma solidity ^0.8.28;

import {BitcoinDepositAddress, GasSettings} from "../BitcoinDepositAddress.sol";

/// @title TestableBitcoinDepositAddress
/// @notice Replays the validation block of `_requestSignature` (gas floor + signature
/// state checks + `pendingSignatures` write) without invoking Aurora precompiles, so
/// the gas / cooldown / state-collision logic can be unit-tested in Hardhat.
/// @dev Constants below MUST match `BitcoinDepositAddress.sol`. They are mirrored
/// because the production constants are `private` and the production contract is
/// audited / out of scope for this PR. If those values are ever changed, update
/// the mirrors here too — the test suite will not catch drift on its own.
contract TestableBitcoinDepositAddress is BitcoinDepositAddress {
  uint256 private constant TEST_PENDING_SIGNATURE_COOLDOWN = 5 minutes;
  uint64 private constant TEST_MIN_SIGN_GAS = 30_000_000_000_000;
  uint64 private constant TEST_MIN_CALLBACK_GAS = 20_000_000_000_000;

  constructor(
    address _owner,
    address _sweepBuilder,
    string memory _nearSigner,
    address _wNEAR
  ) BitcoinDepositAddress(_owner, _sweepBuilder, _nearSigner, _wNEAR) {}

  /// @notice Mirrors `sweep()` body but skips the NEAR precompile call.
  function sweepNoCall(
    bytes32 orderId,
    bytes calldata data,
    GasSettings calldata gasSettings
  ) external {
    (bytes memory payload, uint64 sweepAmount) = sweepBuilder.buildSweepPayload(
      orderId,
      data
    );
    bytes32 hash = sweepBuilder.hashToSign(payload);
    sweepPayloads[orderId][hash] = payload;
    emit SweepSubmitted(orderId, payload, sweepAmount);
    _requestSignatureNoCall(orderId, hash, gasSettings);
  }

  /// @notice Test-only setter to simulate a completed MPC signature.
  function setSignedPayload(
    bytes32 orderId,
    bytes32 hash,
    bytes calldata signature
  ) external {
    signedPayloads[orderId][hash] = signature;
  }

  /// @dev Mirrors `BitcoinDepositAddress._requestSignature` lines 194-212.
  function _requestSignatureNoCall(
    bytes32 orderId,
    bytes32 hash,
    GasSettings calldata gasSettings
  ) internal {
    if (gasSettings.signGas < TEST_MIN_SIGN_GAS) {
      revert InsufficientGas(gasSettings.signGas, TEST_MIN_SIGN_GAS);
    }
    if (gasSettings.callbackGas < TEST_MIN_CALLBACK_GAS) {
      revert InsufficientGas(gasSettings.callbackGas, TEST_MIN_CALLBACK_GAS);
    }

    if (signedPayloads[orderId][hash].length > 0) {
      revert SignatureAlreadyComplete(orderId, hash);
    }

    uint256 expiration = pendingSignatures[orderId][hash];
    if (block.timestamp < expiration) {
      revert SignaturePending(orderId, expiration);
    }

    pendingSignatures[orderId][hash] =
      block.timestamp + TEST_PENDING_SIGNATURE_COOLDOWN;
  }
}
