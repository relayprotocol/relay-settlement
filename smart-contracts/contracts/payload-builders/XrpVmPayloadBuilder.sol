// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {GasPaidPayloadBuilder} from "./GasPaidPayloadBuilder.sol";
import {Sha512} from "./utils/Sha512.sol";

/// @notice Decoded fields for a native-XRP `Payment`, mirroring the settlement
///         SDK `xrp-vm` withdrawal codec. `signingPubKey` is copied from the
///         builder immutables into the payload so off-chain code can recompute
///         the signing hash from the payload alone (as TON does for its wallet
///         immutables).
struct XrpPaymentRequest {
  bytes20 account; // sending depository AccountID
  bytes20 destination; // receiver AccountID
  uint64 amount; // native XRP amount in drops
  uint64 fee; // fee in drops (paid by the depository)
  uint32 sequence;
  uint32 lastLedgerSequence;
  uint32 flags;
  uint32 destinationTag; // only meaningful when hasDestinationTag is true
  bool hasDestinationTag;
  bytes signingPubKey; // 33-byte signing public key
}

/// @notice Per-request fields the solver supplies in `params.data`; they depend
///         on live XRPL account/ledger state and cannot be derived on-chain.
struct XrpRequestData {
  uint32 sequence;
  uint64 fee;
  uint32 lastLedgerSequence;
  uint32 flags;
  uint32 destinationTag;
  bool hasDestinationTag;
}

/// @title XrpVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "xrp-vm" chains (XRP Ledger, native XRP only).
/// @dev Produces the XRPL single-signing hash
///      `SHA512Half(0x53545800 || canonically-serialized-Payment)` that the
///      allocator signs with secp256k1; off-chain code assembles the signature
///      and `SigningPubKey` into a submittable transaction. The depository
///      authorizes this builder's signing key (master key or RegularKey); key
///      custody is handled by the threshold signer, as with the other VMs.
///      XRPL withdrawals spend depository funds on the transaction `Fee`, so
///      building a payload requires a matching gas payment recorded via the
///      `WithdrawGasPayer` contract (see `GasPaidPayloadBuilder`).
contract XrpVmPayloadBuilder is IPayloadBuilder, GasPaidPayloadBuilder {
  error InvalidReceiverLength(uint256 length);
  error InvalidDepositoryLength(uint256 length);
  error InvalidCurrencyLength(uint256 length);
  error UnsupportedCurrency();
  error AmountExceedsMaxDrops(uint256 amount);
  error FeeExceedsMaxFee(uint64 fee, uint64 maxFee);
  error FeeExceedsPaidGas(uint64 fee, uint256 paidAmount);
  error InvalidSigningPubKeyLength(uint256 length);
  error InvalidSigningPubKeyPrefix(bytes1 prefix);

  /// @notice Maximum total XRP supply in drops (10^17), the largest valid amount.
  uint64 internal constant MAX_DROPS = 100000000000000000;

  /// @notice Upper bound (in drops) on the caller-supplied XRPL transaction fee,
  ///         set to 1 XRP (1_000_000 drops).
  /// @dev The `Fee` field is burned from the sending depository account; the
  ///      spender compensates the depository out-of-band via `WithdrawGasPayer`,
  ///      but the payment amount is fixed per chain rather than per request, so
  ///      an unbounded fee would still let a self-service spender drain the
  ///      shared depository reserve. XRPL fees are a
  ///      network-wide property (reference fee ~10 drops), so this is a fixed
  ///      constant rather than a per-deployment parameter: 1 XRP is ~100,000x
  ///      the reference fee — far above any realistic load-based escalation and
  ///      below the 2 XRP ceiling standard clients enforce — while keeping
  ///      reserve drain infeasible.
  uint64 public constant MAX_FEE = 1000000;

  /// @notice Serialized native-XRP amount flag: not-issued (bit 63 clear) and
  ///         positive (bit 62 set).
  uint64 internal constant NATIVE_AMOUNT_FLAG = 0x4000000000000000;

  uint256 internal constant ACCOUNT_ID_LENGTH = 20;

  /// @notice Leading byte of the compressed signing key (0x02 or 0x03).
  bytes1 public immutable SIGNING_PUBKEY_PREFIX;

  /// @notice Trailing 32 bytes (X coordinate) of the compressed signing key.
  bytes32 public immutable SIGNING_PUBKEY_BODY;

  /// @notice Binds the builder to the allocator's XRP signing key.
  /// @param signingPubKey 33-byte compressed secp256k1 public key of the
  ///        allocator's XRP signer (master key or RegularKey of the depository).
  /// @param gasPayer WithdrawGasPayer contract whose payments authorize builds
  constructor(
    bytes memory signingPubKey,
    address gasPayer
  ) GasPaidPayloadBuilder(gasPayer) {
    if (signingPubKey.length != 33) {
      revert InvalidSigningPubKeyLength(signingPubKey.length);
    }
    bytes1 prefix = signingPubKey[0];
    if (prefix != 0x02 && prefix != 0x03) {
      revert InvalidSigningPubKeyPrefix(prefix);
    }
    bytes32 body;
    assembly {
      body := mload(add(add(signingPubKey, 0x20), 1))
    }
    SIGNING_PUBKEY_PREFIX = prefix;
    SIGNING_PUBKEY_BODY = body;
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Reverts with `GasNotPaid` unless a gas payment is recorded for the
  ///      exact withdraw parameters, and with `FeeExceedsPaidGas` when the
  ///      transaction `Fee` (spent by the depository) exceeds the amount that
  ///      was pre-paid — both are in drops, since native-XRP hub balances are
  ///      denominated in drops. Receiver and depository must be 20-byte
  ///      AccountIDs; currency must be the all-zero native sentinel (issued
  ///      assets are rejected). Sequence, fee, lastLedgerSequence, flags and
  ///      destinationTag come from `params.data`.
  function buildPayload(
    string calldata chainId,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    uint256 paidAmount = _requireGasPaid(chainId, depository, params);

    if (depository.length != ACCOUNT_ID_LENGTH) {
      revert InvalidDepositoryLength(depository.length);
    }
    if (params.receiver.length != ACCOUNT_ID_LENGTH) {
      revert InvalidReceiverLength(params.receiver.length);
    }
    if (params.currency.length != ACCOUNT_ID_LENGTH) {
      revert InvalidCurrencyLength(params.currency.length);
    }
    if (bytes20(params.currency) != bytes20(0)) {
      revert UnsupportedCurrency();
    }
    if (params.amount > MAX_DROPS) {
      revert AmountExceedsMaxDrops(params.amount);
    }

    XrpRequestData memory data = abi.decode(params.data, (XrpRequestData));
    if (data.fee > MAX_FEE) {
      revert FeeExceedsMaxFee(data.fee, MAX_FEE);
    }
    // The Fee field is spent by the depository; the pre-paid gas burn must
    // cover it so the depository is never out of pocket.
    if (data.fee > paidAmount) {
      revert FeeExceedsPaidGas(data.fee, paidAmount);
    }

    XrpPaymentRequest memory request = XrpPaymentRequest({
      account: bytes20(depository),
      destination: bytes20(params.receiver),
      amount: uint64(params.amount),
      fee: data.fee,
      sequence: data.sequence,
      lastLedgerSequence: data.lastLedgerSequence,
      flags: data.flags,
      destinationTag: data.destinationTag,
      hasDestinationTag: data.hasDestinationTag,
      signingPubKey: abi.encodePacked(
        SIGNING_PUBKEY_PREFIX,
        SIGNING_PUBKEY_BODY
      )
    });

    return abi.encode(request);
  }

  /// @inheritdoc IPayloadBuilder
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    XrpPaymentRequest memory request = abi.decode(payload, (XrpPaymentRequest));

    hashes = new bytes32[](1);
    hashes[0] = Sha512.hashHalf(_serializeForSigning(request));
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "xrp-vm";
  }

  /// @notice Serializes the Payment in XRPL canonical (type, field) order,
  ///         prefixed with the single-signing prefix `0x53545800`. Native XRP
  ///         amounts carry `NATIVE_AMOUNT_FLAG`. Each field is preceded by its
  ///         XRPL field id (and, for Blob/AccountID, a variable-length prefix).
  /// @param request Decoded Payment request
  /// @return The bytes to hash with SHA-512Half
  function _serializeForSigning(
    XrpPaymentRequest memory request
  ) internal pure returns (bytes memory) {
    uint64 amount = request.amount | NATIVE_AMOUNT_FLAG;
    uint64 fee = request.fee | NATIVE_AMOUNT_FLAG;

    bytes memory head = abi.encodePacked(
      hex"53545800", // signing prefix
      hex"120000", // TransactionType = Payment
      hex"22",
      request.flags,
      hex"24",
      request.sequence
    );
    bytes memory tail = abi.encodePacked(
      hex"201b",
      request.lastLedgerSequence,
      hex"61",
      amount,
      hex"68",
      fee,
      hex"7321",
      request.signingPubKey, // Blob, VL 0x21 (33 bytes)
      hex"8114",
      request.account, // AccountID, VL 0x14 (20 bytes)
      hex"8314",
      request.destination
    );

    // DestinationTag sorts between Sequence and LastLedgerSequence.
    if (request.hasDestinationTag) {
      return abi.encodePacked(head, hex"2e", request.destinationTag, tail);
    }
    return abi.encodePacked(head, tail);
  }
}
