// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Order Types
/// @author Relay Protocol
/// @notice Defines Order structs and EIP-712 typehashes for cross-chain orders

/// @notice Payment details for an order input
struct InputPayment {
  string chainId;
  bytes currency;
  uint256 amount;
  uint256 weight;
}

/// @notice Refund configuration for an order input
struct InputRefund {
  string chainId;
  bytes recipient;
  bytes currency;
  uint256 minimumAmount;
  uint32 deadline;
  bytes extraData;
}

/// @notice Order input containing payment and refund options
struct Input {
  InputPayment payment;
  InputRefund[] refunds;
}

/// @notice Payment details for an order output
struct OutputPayment {
  bytes recipient;
  bytes currency;
  uint256 minimumAmount;
  uint256 expectedAmount;
}

/// @notice Order output containing payments and execution details
struct Output {
  string chainId;
  OutputPayment[] payments;
  uint32 deadline;
  bytes[] calls;
  bytes extraData;
}

/// @notice Fee configuration for an order
struct Fee {
  string recipientChainId;
  bytes recipient;
  string currencyChainId;
  bytes currency;
  uint256 amount;
}

/// @notice Cross-chain order structure
struct Order {
  string version;
  string solverChainId;
  address solver;
  uint256 salt;
  Input[] inputs;
  Output output;
  Fee[] fees;
}

/// @title OrderHash
/// @author Relay Protocol
/// @notice Library for computing EIP-712 order hashes
library OrderHash {
  bytes32 private constant INPUT_PAYMENT_TYPEHASH =
    keccak256(
      "InputPayment(string chainId,bytes currency,uint256 amount,uint256 weight)"
    );

  bytes32 private constant INPUT_REFUND_TYPEHASH =
    keccak256(
      "InputRefund(string chainId,bytes recipient,bytes currency,uint256 minimumAmount,uint32 deadline,bytes extraData)"
    );

  bytes32 private constant INPUT_TYPEHASH =
    keccak256(
      "Input(InputPayment payment,InputRefund[] refunds)InputPayment(string chainId,bytes currency,uint256 amount,uint256 weight)InputRefund(string chainId,bytes recipient,bytes currency,uint256 minimumAmount,uint32 deadline,bytes extraData)"
    );

  bytes32 private constant OUTPUT_PAYMENT_TYPEHASH =
    keccak256(
      "OutputPayment(bytes recipient,bytes currency,uint256 minimumAmount,uint256 expectedAmount)"
    );

  bytes32 private constant OUTPUT_TYPEHASH =
    keccak256(
      "Output(string chainId,OutputPayment[] payments,uint32 deadline,bytes[] calls,bytes extraData)OutputPayment(bytes recipient,bytes currency,uint256 minimumAmount,uint256 expectedAmount)"
    );

  bytes32 private constant FEE_TYPEHASH =
    keccak256(
      "Fee(string recipientChainId,bytes recipient,string currencyChainId,bytes currency,uint256 amount)"
    );

  bytes32 private constant ORDER_TYPEHASH =
    keccak256(
      "Order(string version,string solverChainId,address solver,uint256 salt,Input[] inputs,Output output,Fee[] fees)Fee(string recipientChainId,bytes recipient,string currencyChainId,bytes currency,uint256 amount)Input(InputPayment payment,InputRefund[] refunds)InputPayment(string chainId,bytes currency,uint256 amount,uint256 weight)InputRefund(string chainId,bytes recipient,bytes currency,uint256 minimumAmount,uint32 deadline,bytes extraData)Output(string chainId,OutputPayment[] payments,uint32 deadline,bytes[] calls,bytes extraData)OutputPayment(bytes recipient,bytes currency,uint256 minimumAmount,uint256 expectedAmount)"
    );

  /// @notice Computes the EIP-712 hash of an order
  /// @param order The order to hash
  /// @return The order hash (orderId)
  function hash(Order calldata order) internal pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          ORDER_TYPEHASH,
          keccak256(bytes(order.version)),
          keccak256(bytes(order.solverChainId)),
          order.solver,
          order.salt,
          _hashInputs(order.inputs),
          _hashOutput(order.output),
          _hashFees(order.fees)
        )
      );
  }

  /// @notice Hashes an array of inputs
  /// @param inputs The inputs to hash
  /// @return The hash of the inputs array
  function _hashInputs(Input[] calldata inputs) private pure returns (bytes32) {
    uint256 length = inputs.length;
    bytes32[] memory hashes = new bytes32[](length);
    for (uint256 i; i < length; ) {
      hashes[i] = _hashInput(inputs[i]);
      unchecked {
        ++i;
      }
    }
    return keccak256(abi.encodePacked(hashes));
  }

  /// @notice Hashes a single input
  /// @param input The input to hash
  /// @return The hash of the input
  function _hashInput(Input calldata input) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          INPUT_TYPEHASH,
          _hashInputPayment(input.payment),
          _hashInputRefunds(input.refunds)
        )
      );
  }

  /// @notice Hashes an input payment
  /// @param payment The payment to hash
  /// @return The hash of the payment
  function _hashInputPayment(
    InputPayment calldata payment
  ) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          INPUT_PAYMENT_TYPEHASH,
          keccak256(bytes(payment.chainId)),
          keccak256(payment.currency),
          payment.amount,
          payment.weight
        )
      );
  }

  /// @notice Hashes an array of input refunds
  /// @param refunds The refunds to hash
  /// @return The hash of the refunds array
  function _hashInputRefunds(
    InputRefund[] calldata refunds
  ) private pure returns (bytes32) {
    uint256 length = refunds.length;
    bytes32[] memory hashes = new bytes32[](length);
    for (uint256 i; i < length; ) {
      hashes[i] = _hashInputRefund(refunds[i]);
      unchecked {
        ++i;
      }
    }
    return keccak256(abi.encodePacked(hashes));
  }

  /// @notice Hashes a single input refund
  /// @param refund The refund to hash
  /// @return The hash of the refund
  function _hashInputRefund(
    InputRefund calldata refund
  ) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          INPUT_REFUND_TYPEHASH,
          keccak256(bytes(refund.chainId)),
          keccak256(refund.recipient),
          keccak256(refund.currency),
          refund.minimumAmount,
          refund.deadline,
          keccak256(refund.extraData)
        )
      );
  }

  /// @notice Hashes an output
  /// @param output The output to hash
  /// @return The hash of the output
  function _hashOutput(Output calldata output) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          OUTPUT_TYPEHASH,
          keccak256(bytes(output.chainId)),
          _hashOutputPayments(output.payments),
          output.deadline,
          _hashCalls(output.calls),
          keccak256(output.extraData)
        )
      );
  }

  /// @notice Hashes an array of output payments
  /// @param payments The payments to hash
  /// @return The hash of the payments array
  function _hashOutputPayments(
    OutputPayment[] calldata payments
  ) private pure returns (bytes32) {
    uint256 length = payments.length;
    bytes32[] memory hashes = new bytes32[](length);
    for (uint256 i; i < length; ) {
      hashes[i] = _hashOutputPayment(payments[i]);
      unchecked {
        ++i;
      }
    }
    return keccak256(abi.encodePacked(hashes));
  }

  /// @notice Hashes a single output payment
  /// @param payment The payment to hash
  /// @return The hash of the payment
  function _hashOutputPayment(
    OutputPayment calldata payment
  ) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          OUTPUT_PAYMENT_TYPEHASH,
          keccak256(payment.recipient),
          keccak256(payment.currency),
          payment.minimumAmount,
          payment.expectedAmount
        )
      );
  }

  /// @notice Hashes an array of calls
  /// @param calls The calls to hash
  /// @return The hash of the calls array
  function _hashCalls(bytes[] calldata calls) private pure returns (bytes32) {
    uint256 length = calls.length;
    bytes32[] memory hashes = new bytes32[](length);
    for (uint256 i; i < length; ) {
      hashes[i] = keccak256(calls[i]);
      unchecked {
        ++i;
      }
    }
    return keccak256(abi.encodePacked(hashes));
  }

  /// @notice Hashes an array of fees
  /// @param fees The fees to hash
  /// @return The hash of the fees array
  function _hashFees(Fee[] calldata fees) private pure returns (bytes32) {
    uint256 length = fees.length;
    bytes32[] memory hashes = new bytes32[](length);
    for (uint256 i; i < length; ) {
      hashes[i] = _hashFee(fees[i]);
      unchecked {
        ++i;
      }
    }
    return keccak256(abi.encodePacked(hashes));
  }

  /// @notice Hashes a single fee
  /// @param fee The fee to hash
  /// @return The hash of the fee
  function _hashFee(Fee calldata fee) private pure returns (bytes32) {
    return
      keccak256(
        abi.encode(
          FEE_TYPEHASH,
          keccak256(bytes(fee.recipientChainId)),
          keccak256(fee.recipient),
          keccak256(bytes(fee.currencyChainId)),
          keccak256(fee.currency),
          fee.amount
        )
      );
  }
}
