// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Currency, IPricingOracle, Price} from "./oracle/IPricingOracle.sol";

/// @title RelayDepositAddressManager
/// @author Relay Protocol
/// @notice Entry point for triggering deposit address signing actions.
contract RelayDepositAddressManager {
  /// @notice Describes the funds being deposited into the deposit address.
  /// @param vmType Identifier of the source virtual machine
  /// @param chainId Identifier of the source chain
  /// @param currency Opaque, VM-specific encoding of the currency being deposited
  /// @param amount Amount of `currency` being deposited, in its smallest unit
  struct Input {
    string vmType;
    string chainId;
    bytes currency;
    uint256 amount;
  }

  /// @notice Fields that alone deterministically derive the deposit
  /// address. Two triggers sharing the same `DerivationFields` resolve to
  /// the same deposit address, regardless of the input or order id.
  /// @param inputVmType Identifier of the source virtual machine
  /// @param outputVmType Identifier of the destination virtual machine
  /// @param outputChainId Identifier of the destination chain
  /// @param outputCurrency Opaque, VM-specific encoding of the destination currency
  /// @param outputRecipient Opaque, VM-specific encoding of the recipient address on the destination chain
  /// @param solver Address of the solver that released the order
  /// @param pricingOracle Address of the `IPricingOracle` consulted by the trigger method to capture USD prices into the trigger hash
  /// @param depositor Opaque, VM-specific encoding of the depositor on the source chain
  /// @param refundRecipient Opaque, VM-specific encoding of the refund recipient on the source chain
  /// @param slippageBps Maximum allowed slippage on the output, in basis points
  struct DerivationFields {
    string inputVmType;
    string outputVmType;
    string outputChainId;
    bytes outputCurrency;
    bytes outputRecipient;
    address solver;
    address pricingOracle;
    bytes depositor;
    bytes refundRecipient;
    uint256 slippageBps;
  }

  /// @notice Emitted when a deposit address trigger is recorded.
  /// @param orderId Unique identifier of the triggered order
  /// @param triggerHash Simple tracking hash binding all relevant data
  event Triggered(bytes32 indexed orderId, bytes32 triggerHash);

  /// @notice Thrown when attempting to record a trigger whose hash has
  /// already been stored.
  /// @param triggerHash The trigger hash that was already recorded
  error AlreadyTriggered(bytes32 triggerHash);

  /// @notice Thrown when the input's `vmType` does not match the derivation
  /// fields' `inputVmType`.
  error InputVmTypeMismatch();

  /// @notice Thrown when `trigger` is invoked with a zero `orderId`, since a
  /// zero value is reserved to indicate the absence of a stored trigger.
  error InvalidOrderId();

  /// @notice Order id stored per trigger hash. A non-zero value indicates
  /// that a trigger with the given hash has already been recorded.
  mapping(bytes32 triggerHash => bytes32 orderId) public triggers;

  /// @notice Records a deposit address trigger by hashing its parameters
  /// together with the USD prices of the requested currencies and storing
  /// the order id under the resulting tracking hash.
  /// @dev Reverts with `InputVmTypeMismatch` if `input.vmType` differs from
  /// `derivationFields.inputVmType`, and with `AlreadyTriggered` if a
  /// trigger with the same hash has already been recorded. `currencies` and
  /// `extraData` are forwarded in a single batched call to the
  /// `IPricingOracle` referenced by `derivationFields.pricingOracle`. The
  /// caller-supplied `nonce` allows otherwise-identical triggers to be
  /// recorded multiple times. All inputs are bound positionally into the
  /// trigger hash, so downstream consumers can verify which oracle was
  /// used, which currencies were queried, the prices observed at trigger
  /// time and any oracle-specific parameters supplied by the caller.
  /// @param input Description of the funds being deposited
  /// @param derivationFields Fields that deterministically derive the deposit address
  /// @param orderId Unique identifier of the order being triggered
  /// @param nonce Caller-supplied nonce that disambiguates triggers sharing otherwise-identical parameters
  /// @param currencies Currencies whose USD prices should be captured into the trigger hash
  /// @param extraData Opaque data forwarded to the pricing oracle (eg. signed price attestations) and bound into the trigger hash
  function trigger(
    Input calldata input,
    DerivationFields calldata derivationFields,
    bytes32 orderId,
    uint256 nonce,
    Currency[] calldata currencies,
    bytes calldata extraData
  ) external {
    if (orderId == bytes32(0)) {
      revert InvalidOrderId();
    }

    if (
      keccak256(bytes(input.vmType)) !=
      keccak256(bytes(derivationFields.inputVmType))
    ) {
      revert InputVmTypeMismatch();
    }

    Price[] memory prices = IPricingOracle(derivationFields.pricingOracle)
      .getUsdPrices(currencies, extraData);

    bytes32 triggerHash = _hashTrigger(
      input,
      derivationFields,
      orderId,
      nonce,
      currencies,
      prices,
      extraData
    );

    if (triggers[triggerHash] != bytes32(0)) {
      revert AlreadyTriggered(triggerHash);
    }

    triggers[triggerHash] = orderId;

    emit Triggered(orderId, triggerHash);
  }

  /// @notice Computes the tracking hash for a trigger.
  /// @dev Uses `abi.encode` to avoid ambiguity when hashing nested structs, dynamic arrays, strings and bytes.
  /// @param input Description of the funds being deposited
  /// @param derivationFields Fields that deterministically derive the deposit address
  /// @param orderId Unique identifier of the order being triggered
  /// @param nonce Caller-supplied nonce bound into the trigger hash
  /// @param currencies Currencies whose USD prices were captured
  /// @param prices USD prices captured for `currencies`, in the same order
  /// @param extraData Opaque data forwarded to the pricing oracle
  /// @return triggerHash Tracking hash of all trigger data
  function _hashTrigger(
    Input calldata input,
    DerivationFields calldata derivationFields,
    bytes32 orderId,
    uint256 nonce,
    Currency[] calldata currencies,
    Price[] memory prices,
    bytes calldata extraData
  ) internal pure returns (bytes32 triggerHash) {
    triggerHash = keccak256(
      abi.encode(
        input,
        derivationFields,
        orderId,
        nonce,
        currencies,
        prices,
        extraData
      )
    );
  }
}
