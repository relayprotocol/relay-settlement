// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BuildPayloadParams, IPayloadBuilder} from "../RelayAllocator.sol";
import {Protobuf} from "./utils/Protobuf.sol";

/// @notice Decoded fields for a Hedera `CryptoTransfer`, mirroring the
///         settlement SDK `hedera-vm` withdrawal codec. Every field ends up
///         inside the serialized transaction body, so all of them are covered
///         by the signature the allocator produces.
struct HederaTransferRequest {
  uint64 payerNum; // submitter account: pays the fee, never debited
  uint64 senderNum; // depository account, debited the full amount
  uint64 receiverNum; // recipient account, credited the full amount
  uint64 amount; // tinybars for HBAR, smallest unit for an HTS token
  uint64 tokenNum; // 0 for HBAR, otherwise the configured HTS token
  uint64 nodeAccountNum; // node the transaction must be submitted to
  uint64 validStartSeconds; // transaction id valid start
  uint32 validStartNanos;
  uint32 validDurationSeconds; // validity window past the valid start
  uint64 maxTransactionFee; // fee ceiling in tinybars, spent by the payer
}

/// @notice Per-request fields the solver supplies in `params.data`; they depend
///         on live Hedera state (which node is healthy, the current clock,
///         which submitter account is funded) and cannot be derived on-chain.
struct HederaRequestData {
  uint64 payerNum;
  uint64 nodeAccountNum;
  uint64 validStartSeconds;
  uint32 validDurationSeconds;
  uint64 maxTransactionFee;
}

/// @title HederaVmPayloadBuilder
/// @author Relay Protocol
/// @notice Payload builder for "hedera-vm" chains, restricted to direct
///         `CryptoTransfer` transactions moving HBAR or one configured HTS
///         token (native Hedera USDC).
/// @dev Produces the Hedera transaction body and the digest the allocator
///      signs. Hedera verifies an ECDSA secp256k1 signature over
///      `keccak256(bodyBytes)`, so `hashesToSign` returns exactly that and the
///      existing secp256k1 threshold signer needs no Hedera-specific handling.
///      Off-chain code wraps the same body bytes and the returned signature in
///      a `SignedTransaction` and submits it.
///
///      The body bytes are byte-for-byte identical to what the Hedera
///      JavaScript SDK produces for the same transfer, including the explicit
///      zero shard, realm, `scheduled`, `is_approval` and memo fields that a
///      minimal proto3 encoder would elide, and the ascending-account-number
///      ordering the SDK applies to transfer entries. A submitter must forward
///      these exact bytes — rebuilding an equivalent transaction would produce
///      a body the signature does not cover.
///
///      Hedera charges the transaction fee to the transaction's payer, which is
///      a separate account from the one being debited. The payer here is the
///      submitter that broadcasts the transaction, not the depository, so
///      withdrawals need no pre-paid gas: the party choosing to submit is the
///      party that bears the fee, exactly as the relayer bears gas on an EVM
///      chain. That is why this builder does not inherit
///      `GasPaidPayloadBuilder` the way the XRPL and TON builders do — on those
///      chains the fee necessarily comes out of the account being debited, so a
///      self-service spender would otherwise drain a reserve backing other
///      users' deposits.
///
///      Because the depository never spends HBAR on fees, its balance can be
///      withdrawn in full rather than having to retain a fee reserve, and a
///      depository holding only HTS tokens needs no HBAR at all.
///
///      Only `CryptoTransfer` bodies can be produced. There is no code path
///      that emits a contract call, an allowance, an approved (delegated)
///      transfer, or a transfer of any token other than the configured one, and
///      recipients must be existing accounts — see `buildPayload`.
contract HederaVmPayloadBuilder is IPayloadBuilder {
  error InvalidReceiverLength(uint256 length);
  error InvalidDepositoryLength(uint256 length);
  error InvalidCurrencyLength(uint256 length);
  error NotAnAccountId(bytes20 address_);
  error UnsupportedCurrency(uint64 tokenNum);
  error InvalidAccount(uint64 accountNum);
  error EntityNumExceedsMax(uint64 num);
  error ReceiverIsSender(uint64 accountNum);
  error PayerIsSender(uint64 accountNum);
  error InvalidAmount(uint256 amount);
  error AmountExceedsMax(uint256 amount, uint256 maxAmount);
  error FeeExceedsMaxFee(uint64 fee, uint64 maxFee);
  error InvalidValidDuration(uint32 validDurationSeconds);
  error InvalidValidStartNanos(uint32 nanos);
  error TransfersDoNotNetToZero();
  error InvalidTokenNum(uint64 tokenNum);

  /// @notice Total HBAR supply in tinybars (50 billion HBAR at 8 decimals), the
  ///         largest amount any HBAR transfer can carry.
  uint64 internal constant MAX_TINYBARS = 5000000000000000000;

  /// @notice Largest value representable by Hedera's `sint64` transfer amount.
  uint64 internal constant MAX_TOKEN_AMOUNT = uint64(type(int64).max);

  /// @notice Largest valid entity number.
  /// @dev Hedera declares the shard, realm and entity number of every
  ///      `AccountID` and `TokenID` as a protobuf `int64`, so the 8-byte field
  ///      a long-zero address carries is only valid up to the signed maximum.
  uint64 internal constant MAX_ENTITY_NUM = uint64(type(int64).max);

  /// @notice Upper bound (in tinybars) on the caller-supplied transaction fee,
  ///         set to 1 HBAR.
  /// @dev A sanity bound rather than a security control: the fee is charged to
  ///      the submitter that supplied it, so an inflated ceiling only costs the
  ///      party that chose to submit. A `CryptoTransfer` costs on the order of
  ///      0.0001 USD (HBAR) to 0.001 USD (HTS), so 1 HBAR is several orders of
  ///      magnitude above any realistic fee and a value above it signals a
  ///      malformed request. Hedera treats this field as a ceiling and charges
  ///      only the fee actually assessed.
  uint64 public constant MAX_FEE = 100000000;

  /// @notice Longest validity window Hedera accepts, in seconds.
  uint32 public constant MAX_VALID_DURATION_SECONDS = 180;

  /// @notice Nanoseconds in a second; the valid start's sub-second component
  ///         must be below this.
  uint32 internal constant NANOS_PER_SECOND = 1000000000;

  uint256 internal constant ADDRESS_LENGTH = 20;

  /// @notice Length of the zero prefix of a long-zero address, in bytes
  uint256 internal constant LONG_ZERO_PREFIX_LENGTH = 12;

  /// @notice HTS token entity number this builder is allowed to transfer
  ///         (native Hedera USDC, `0.0.456858` on mainnet).
  /// @dev Fixed per deployment because the token has a different entity number
  ///      on each network. HBAR needs no configuration: it is addressed by the
  ///      zero currency sentinel.
  uint64 public immutable TOKEN_NUM;

  // ====== Protobuf field numbers ======
  //
  // From the Hedera protobuf service definitions: `TransactionBody`,
  // `TransactionID`, `AccountID`, `TokenID`, `Timestamp`, `Duration`,
  // `CryptoTransferTransactionBody`, `TransferList`, `TokenTransferList` and
  // `AccountAmount`.

  uint8 private constant BODY_TRANSACTION_ID = 1;
  uint8 private constant BODY_NODE_ACCOUNT_ID = 2;
  uint8 private constant BODY_TRANSACTION_FEE = 3;
  uint8 private constant BODY_VALID_DURATION = 4;
  uint8 private constant BODY_MEMO = 6;
  uint8 private constant BODY_CRYPTO_TRANSFER = 14;

  uint8 private constant TRANSACTION_ID_VALID_START = 1;
  uint8 private constant TRANSACTION_ID_ACCOUNT_ID = 2;
  uint8 private constant TRANSACTION_ID_SCHEDULED = 3;

  uint8 private constant ENTITY_SHARD = 1;
  uint8 private constant ENTITY_REALM = 2;
  uint8 private constant ENTITY_NUM = 3;

  uint8 private constant TIMESTAMP_SECONDS = 1;
  uint8 private constant TIMESTAMP_NANOS = 2;

  uint8 private constant DURATION_SECONDS = 1;

  uint8 private constant CRYPTO_TRANSFER_TRANSFERS = 1;
  uint8 private constant CRYPTO_TRANSFER_TOKEN_TRANSFERS = 2;

  uint8 private constant TRANSFER_LIST_ACCOUNT_AMOUNTS = 1;

  uint8 private constant TOKEN_TRANSFER_LIST_TOKEN = 1;
  uint8 private constant TOKEN_TRANSFER_LIST_TRANSFERS = 2;

  uint8 private constant ACCOUNT_AMOUNT_ACCOUNT_ID = 1;
  uint8 private constant ACCOUNT_AMOUNT_AMOUNT = 2;
  uint8 private constant ACCOUNT_AMOUNT_IS_APPROVAL = 3;

  /// @notice Binds the builder to the HTS token it may transfer
  /// @param tokenNum Entity number of the supported HTS token (USDC)
  constructor(uint64 tokenNum) {
    // Entity 0 is the zero sentinel standing for HBAR, never a real token.
    if (tokenNum == 0) {
      revert InvalidTokenNum(tokenNum);
    }
    TOKEN_NUM = tokenNum;
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Depository, receiver and currency are the 20-byte encodings the SDK
  ///      `hedera-vm` address codec produces. All three must be long-zero
  ///      addresses, i.e. plain `0.0.x` entity ids:
  ///
  ///      - the currency selects the asset, and must be the zero sentinel
  ///        (HBAR) or exactly `TOKEN_NUM`, so no other token can be moved;
  ///      The valid start's nanosecond component is derived from the withdraw
  ///      parameters rather than supplied, so that two withdrawal requests
  ///      cannot collide on a transaction id — see `_computeValidStartNanos`.
  ///
  ///      - the receiver must be an existing account rather than an account
  ///        alias. Transferring to an alias would make Hedera auto-create a
  ///        hollow account, which is account creation the protocol has not
  ///        approved and an extra fee the submitter would pay. Aliases are
  ///        resolved to account ids during recipient preflight instead.
  ///
  ///      The submitter's payer account comes from `params.data` because only
  ///      the solver knows which of its accounts is funded at build time. It
  ///      cannot be abused to charge a third party, since Hedera requires the
  ///      payer's own signature and the allocator holds only the depository
  ///      key — but it must never be the depository itself, which the allocator
  ///      *does* sign for, hence `PayerIsSender`. Allowing that would put the
  ///      fee back on the shared reserve this design exists to protect.
  function buildPayload(
    string calldata /* chainId */,
    bytes calldata depository,
    BuildPayloadParams calldata params
  ) external view override returns (bytes memory payload) {
    if (depository.length != ADDRESS_LENGTH) {
      revert InvalidDepositoryLength(depository.length);
    }
    if (params.receiver.length != ADDRESS_LENGTH) {
      revert InvalidReceiverLength(params.receiver.length);
    }
    if (params.currency.length != ADDRESS_LENGTH) {
      revert InvalidCurrencyLength(params.currency.length);
    }

    uint64 senderNum = _entityNum(bytes20(depository));
    uint64 receiverNum = _entityNum(bytes20(params.receiver));
    uint64 tokenNum = _entityNum(bytes20(params.currency));

    if (tokenNum != 0 && tokenNum != TOKEN_NUM) {
      revert UnsupportedCurrency(tokenNum);
    }
    // Entity 0 is the zero sentinel, never a usable account.
    if (senderNum == 0) {
      revert InvalidAccount(senderNum);
    }
    if (receiverNum == 0) {
      revert InvalidAccount(receiverNum);
    }
    // A self-transfer nets to nothing while still burning the fee.
    if (receiverNum == senderNum) {
      revert ReceiverIsSender(receiverNum);
    }

    if (params.amount == 0) {
      revert InvalidAmount(params.amount);
    }
    uint256 maxAmount = tokenNum == 0 ? MAX_TINYBARS : MAX_TOKEN_AMOUNT;
    if (params.amount > maxAmount) {
      revert AmountExceedsMax(params.amount, maxAmount);
    }

    HederaRequestData memory data = abi.decode(
      params.data,
      (HederaRequestData)
    );

    if (data.payerNum == 0) {
      revert InvalidAccount(data.payerNum);
    }
    // Charging the fee to the depository would defeat the point of a separate
    // payer: the allocator signs for the depository, so this is the one value
    // a spender could set that actually costs the shared reserve.
    if (data.payerNum == senderNum) {
      revert PayerIsSender(data.payerNum);
    }
    if (data.nodeAccountNum == 0) {
      revert InvalidAccount(data.nodeAccountNum);
    }
    // The payer and node accounts arrive as raw numbers rather than as
    // long-zero addresses, so they do not pass through `_entityNum`'s bound.
    if (data.payerNum > MAX_ENTITY_NUM) {
      revert EntityNumExceedsMax(data.payerNum);
    }
    if (data.nodeAccountNum > MAX_ENTITY_NUM) {
      revert EntityNumExceedsMax(data.nodeAccountNum);
    }
    if (
      data.validDurationSeconds == 0 ||
      data.validDurationSeconds > MAX_VALID_DURATION_SECONDS
    ) {
      revert InvalidValidDuration(data.validDurationSeconds);
    }
    if (data.maxTransactionFee > MAX_FEE) {
      revert FeeExceedsMaxFee(data.maxTransactionFee, MAX_FEE);
    }

    return
      abi.encode(
        HederaTransferRequest({
          payerNum: data.payerNum,
          senderNum: senderNum,
          receiverNum: receiverNum,
          amount: uint64(params.amount),
          tokenNum: tokenNum,
          nodeAccountNum: data.nodeAccountNum,
          validStartSeconds: data.validStartSeconds,
          validStartNanos: _computeValidStartNanos(params),
          validDurationSeconds: data.validDurationSeconds,
          maxTransactionFee: data.maxTransactionFee
        })
      );
  }

  /// @inheritdoc IPayloadBuilder
  /// @dev Hedera verifies ECDSA secp256k1 signatures over the keccak256 digest
  ///      of the serialized transaction body, so the digest is returned
  ///      directly.
  function hashesToSign(
    string calldata /* chainId */,
    bytes calldata /* depository */,
    bytes calldata payload
  ) external pure override returns (bytes32[] memory hashes) {
    HederaTransferRequest memory request = abi.decode(
      payload,
      (HederaTransferRequest)
    );

    hashes = new bytes32[](1);
    hashes[0] = keccak256(transactionBody(request));
  }

  /// @inheritdoc IPayloadBuilder
  function curve() external pure override returns (string memory name) {
    return "Ecdsa";
  }

  /// @inheritdoc IPayloadBuilder
  function family() external pure override returns (string memory name) {
    return "hedera-vm";
  }

  /// @notice Serializes the Hedera `TransactionBody` that gets signed and
  ///         submitted, so off-chain code can recover the exact bytes covered
  ///         by a signature from the payload alone.
  /// @param request Decoded transfer request
  /// @return The serialized transaction body
  function transactionBody(
    HederaTransferRequest memory request
  ) public pure returns (bytes memory) {
    return
      abi.encodePacked(
        Protobuf.embedded(
          BODY_TRANSACTION_ID,
          _transactionId(
            request.payerNum,
            request.validStartSeconds,
            request.validStartNanos
          )
        ),
        Protobuf.embedded(
          BODY_NODE_ACCOUNT_ID,
          _entity(request.nodeAccountNum)
        ),
        Protobuf.varintField(BODY_TRANSACTION_FEE, request.maxTransactionFee),
        Protobuf.embedded(
          BODY_VALID_DURATION,
          Protobuf.varintField(DURATION_SECONDS, request.validDurationSeconds)
        ),
        // Empty memo, written explicitly to match the Hedera SDK's encoding.
        Protobuf.embedded(BODY_MEMO, new bytes(0)),
        Protobuf.embedded(BODY_CRYPTO_TRANSFER, _cryptoTransfer(request))
      );
  }

  /// @notice Derives the valid start's sub-second component from the withdraw
  ///         parameters, so each withdrawal request gets its own transaction id
  /// @dev A Hedera transaction id is the payer plus the valid start, and the
  ///      network rejects a repeat of one it has already seen. Two withdrawal
  ///      requests that agree on payer, receiver, amount, token, node and
  ///      valid-start second would otherwise serialize to identical bodies and
  ///      therefore share a transaction id, so only the first could ever
  ///      execute. Mixing the request nonce into the nanoseconds separates
  ///      them, and mirrors how `TonVmPayloadBuilder` derives its query id.
  ///
  ///      This is a separation, not a guarantee: the digest is reduced into a
  ///      billion nanosecond slots, so distinct requests can still collide
  ///      within the same second. A collision surfaces as Hedera's
  ///      `DUPLICATE_TRANSACTION`, which the off-chain submitter handles by
  ///      rebuilding at a later `validStartSeconds`.
  ///
  ///      The derivation is deliberately pure — no `block.number` — so that
  ///      off-chain code can reproduce the payload from the same parameters.
  /// @param params Payload builder parameters supplied by the allocator
  /// @return The nanosecond component, in [0, 10^9)
  function _computeValidStartNanos(
    BuildPayloadParams calldata params
  ) internal pure returns (uint32) {
    return
      uint32(
        uint256(
          keccak256(
            abi.encode(
              params.nonce,
              params.currency,
              params.receiver,
              params.amount,
              params.data
            )
          )
        ) % NANOS_PER_SECOND
      );
  }

  /// @notice Reads the entity number out of a 20-byte long-zero address
  /// @dev A long-zero address encodes a `shard.realm.num` entity id as 4 bytes
  ///      of shard, 8 of realm and 8 of num. Only shard 0 / realm 0 entities
  ///      exist on Hedera's networks, so every entity address begins with 12
  ///      zero bytes; a nonzero prefix means the value is an account's EVM
  ///      alias, which carries no entity id and is rejected.
  ///
  ///      Hedera declares every entity number as a protobuf `int64`, so the
  ///      8-byte field is only valid up to the signed maximum. A larger value
  ///      would serialize to a varint the network reads back as a negative
  ///      entity number, so it is rejected rather than encoded.
  /// @param address_ The 20-byte encoded address
  /// @return The entity number
  function _entityNum(bytes20 address_) internal pure returns (uint64) {
    for (uint256 i = 0; i < LONG_ZERO_PREFIX_LENGTH; i++) {
      if (address_[i] != 0) {
        revert NotAnAccountId(address_);
      }
    }
    uint64 num = uint64(uint160(address_));
    if (num > MAX_ENTITY_NUM) {
      revert EntityNumExceedsMax(num);
    }
    return num;
  }

  /// @notice Serializes an `AccountID` or `TokenID`
  /// @dev Both messages number their shard, realm and entity fields
  ///      identically, so one helper covers them. Shard and realm are written
  ///      as explicit zeros, matching the Hedera SDK. Entity numbers are
  ///      `int64` in the Hedera protobufs, so anything above the signed maximum
  ///      is rejected rather than serialized as a negative number.
  /// @param num The entity number
  /// @return The serialized entity id
  function _entity(uint64 num) internal pure returns (bytes memory) {
    // Re-checked here rather than trusting `buildPayload`, because every entity
    // number reaches the wire through this function, including on the
    // `transactionBody` / `hashesToSign` path that accepts a caller-supplied
    // payload.
    if (num > MAX_ENTITY_NUM) {
      revert EntityNumExceedsMax(num);
    }
    return
      abi.encodePacked(
        Protobuf.varintField(ENTITY_SHARD, 0),
        Protobuf.varintField(ENTITY_REALM, 0),
        Protobuf.varintField(ENTITY_NUM, num)
      );
  }

  /// @notice Serializes the `TransactionID`
  /// @dev `scheduled` is written as an explicit false and the nonce is omitted,
  ///      matching the Hedera SDK: these payloads are never scheduled and never
  ///      child transactions.
  /// @param payerNum The paying account
  /// @param validStartSeconds Valid start, seconds
  /// @param validStartNanos Valid start, nanoseconds
  /// @return The serialized transaction id
  function _transactionId(
    uint64 payerNum,
    uint64 validStartSeconds,
    uint32 validStartNanos
  ) internal pure returns (bytes memory) {
    // `buildPayload` derives this below a second, but `hashesToSign` accepts a
    // caller-supplied payload, so the serializer bounds it too.
    if (validStartNanos >= NANOS_PER_SECOND) {
      revert InvalidValidStartNanos(validStartNanos);
    }
    return
      abi.encodePacked(
        Protobuf.embedded(
          TRANSACTION_ID_VALID_START,
          abi.encodePacked(
            Protobuf.varintField(TIMESTAMP_SECONDS, validStartSeconds),
            Protobuf.varintField(TIMESTAMP_NANOS, validStartNanos)
          )
        ),
        Protobuf.embedded(TRANSACTION_ID_ACCOUNT_ID, _entity(payerNum)),
        Protobuf.varintField(TRANSACTION_ID_SCHEDULED, 0)
      );
  }

  /// @notice Serializes the `CryptoTransferTransactionBody`
  /// @dev HBAR moves through the `transfers` list; an HTS token moves through a
  ///      single `tokenTransferList`, alongside an empty `transfers` list that
  ///      the Hedera SDK also emits. Either way the body carries exactly two
  ///      transfer entries — the depository debited and the receiver credited by the
  ///      same amount — so it nets to zero, which Hedera requires.
  /// @param request Decoded transfer request
  /// @return The serialized crypto transfer body
  function _cryptoTransfer(
    HederaTransferRequest memory request
  ) internal pure returns (bytes memory) {
    bytes memory entries = _transferEntries(
      request,
      request.tokenNum == 0
        ? TRANSFER_LIST_ACCOUNT_AMOUNTS
        : TOKEN_TRANSFER_LIST_TRANSFERS
    );

    if (request.tokenNum == 0) {
      return Protobuf.embedded(CRYPTO_TRANSFER_TRANSFERS, entries);
    }

    return
      abi.encodePacked(
        // Empty HBAR transfer list, written explicitly to match the Hedera SDK.
        Protobuf.embedded(CRYPTO_TRANSFER_TRANSFERS, new bytes(0)),
        Protobuf.embedded(
          CRYPTO_TRANSFER_TOKEN_TRANSFERS,
          abi.encodePacked(
            Protobuf.embedded(
              TOKEN_TRANSFER_LIST_TOKEN,
              _entity(request.tokenNum)
            ),
            entries
          )
        )
      );
  }

  /// @notice Serializes the debit and credit `AccountAmount` entries
  /// @dev The Hedera SDK orders transfer entries by ascending account number,
  ///      so the entries are emitted in that order rather than debit-first.
  ///      The debit and credit are the same magnitude with opposite signs, and
  ///      the sum is checked before serializing so a future change that breaks
  ///      the invariant fails loudly instead of producing a body Hedera would
  ///      reject.
  ///
  ///      The debited account is the depository, not the transaction's payer:
  ///      the fee is charged to the payer outside this list, which is why the
  ///      list still nets to zero with only two entries.
  /// @param request Decoded transfer request
  /// @param fieldNumber Field number the entries are repeated under
  /// @return The serialized entries, in ascending account order
  function _transferEntries(
    HederaTransferRequest memory request,
    uint8 fieldNumber
  ) internal pure returns (bytes memory) {
    // Re-checked here rather than trusting `buildPayload`, because this is
    // the function that defines the bytes a signature covers and it is
    // reachable through `hashesToSign` with an arbitrary payload. Above the
    // signed maximum the conversion below would wrap and silently swap the
    // debit and credit.
    if (request.amount == 0 || request.amount > MAX_TOKEN_AMOUNT) {
      revert InvalidAmount(request.amount);
    }

    int64 debit = -int64(request.amount);
    int64 credit = int64(request.amount);
    if (debit + credit != 0) {
      revert TransfersDoNotNetToZero();
    }

    bytes memory senderEntry = Protobuf.embedded(
      fieldNumber,
      _accountAmount(request.senderNum, debit)
    );
    bytes memory receiverEntry = Protobuf.embedded(
      fieldNumber,
      _accountAmount(request.receiverNum, credit)
    );

    return
      request.senderNum < request.receiverNum
        ? abi.encodePacked(senderEntry, receiverEntry)
        : abi.encodePacked(receiverEntry, senderEntry);
  }

  /// @notice Serializes an `AccountAmount`
  /// @dev `is_approval` is written as an explicit false, matching the Hedera
  ///      SDK: these transfers always spend the depository's own balance, never
  ///      an allowance granted to it.
  /// @param accountNum The account
  /// @param amount The signed amount, negative for a debit
  /// @return The serialized account amount
  function _accountAmount(
    uint64 accountNum,
    int64 amount
  ) internal pure returns (bytes memory) {
    return
      abi.encodePacked(
        Protobuf.embedded(ACCOUNT_AMOUNT_ACCOUNT_ID, _entity(accountNum)),
        Protobuf.sint64Field(ACCOUNT_AMOUNT_AMOUNT, amount),
        Protobuf.varintField(ACCOUNT_AMOUNT_IS_APPROVAL, 0)
      );
  }
}
