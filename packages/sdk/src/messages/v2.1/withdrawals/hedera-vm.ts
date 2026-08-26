import { keccak256, parseAbiParameters } from "viem"

import { formatHederaEntityId, parseHederaAddress } from "../../../hedera-vm"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

export type DecodedHederaVmWithdrawal = {
  vmType: "hedera-vm"
  withdrawal: {
    /// Submitter account id (`0.0.x`) that pays the transaction fee. Never
    /// debited, and never the depository — the fee is deliberately borne by the
    /// party that chose to submit, so no pre-paid gas is required.
    payer: string
    /// Depository account id (`0.0.x`), debited the full amount
    sender: string
    /// Recipient account id (`0.0.x`). Account aliases are rejected — see the
    /// note on `hederaVmCodec` — so this is always an existing account.
    receiver: string
    /// Tinybars for HBAR, smallest unit for an HTS token
    amount: string
    /// HTS token id (`0.0.456858` for mainnet USDC), or `0.0.0` for HBAR
    token: string
    /// Account id of the node the transaction must be submitted to
    nodeAccount: string
    /// Transaction id valid start, as `seconds.nanoseconds`
    validStart: string
    /// Validity window past the valid start, in seconds (Hedera caps this at
    /// 180)
    validDurationSeconds: number
    /// Fee ceiling in tinybars, spent by the payer. Hedera charges only the fee
    /// actually assessed.
    maxTransactionFee: string
  }
}

type Withdrawal = DecodedHederaVmWithdrawal["withdrawal"]

// Mirrors HederaVmPayloadBuilder.sol `abi.encode(HederaTransferRequest)`.
// Accounts and tokens are carried as their entity numbers rather than as
// 20-byte addresses: the contract reads the number out of the long-zero address
// once, up front, so everything downstream of validation works with the entity
// id Hedera itself uses.
const hederaTransferRequestAbiParams = parseAbiParameters([
  "(uint64 payerNum, uint64 senderNum, uint64 receiverNum, uint64 amount, uint64 tokenNum, uint64 nodeAccountNum, uint64 validStartSeconds, uint32 validStartNanos, uint32 validDurationSeconds, uint64 maxTransactionFee)",
])

// ====== Protobuf serialization ======
//
// Field numbers from the Hedera protobuf service definitions; see
// HederaVmPayloadBuilder.sol, whose serializer this mirrors byte for byte.

const BODY_TRANSACTION_ID = 1
const BODY_NODE_ACCOUNT_ID = 2
const BODY_TRANSACTION_FEE = 3
const BODY_VALID_DURATION = 4
const BODY_MEMO = 6
const BODY_CRYPTO_TRANSFER = 14

const TRANSACTION_ID_VALID_START = 1
const TRANSACTION_ID_ACCOUNT_ID = 2
const TRANSACTION_ID_SCHEDULED = 3

const ENTITY_SHARD = 1
const ENTITY_REALM = 2
const ENTITY_NUM = 3

const TIMESTAMP_SECONDS = 1
const TIMESTAMP_NANOS = 2

const DURATION_SECONDS = 1

const CRYPTO_TRANSFER_TRANSFERS = 1
const CRYPTO_TRANSFER_TOKEN_TRANSFERS = 2

const TRANSFER_LIST_ACCOUNT_AMOUNTS = 1

const TOKEN_TRANSFER_LIST_TOKEN = 1
const TOKEN_TRANSFER_LIST_TRANSFERS = 2

const ACCOUNT_AMOUNT_ACCOUNT_ID = 1
const ACCOUNT_AMOUNT_AMOUNT = 2
const ACCOUNT_AMOUNT_IS_APPROVAL = 3

const WIRE_VARINT = 0
const WIRE_LENGTH_DELIMITED = 2

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const varint = (value: bigint): Uint8Array => {
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80)
    remaining >>= 7n
  }
  bytes.push(Number(remaining))
  return Uint8Array.from(bytes)
}

const tag = (fieldNumber: number, wireType: number): Uint8Array =>
  Uint8Array.from([(fieldNumber << 3) | wireType])

const varintField = (fieldNumber: number, value: bigint): Uint8Array =>
  concat(tag(fieldNumber, WIRE_VARINT), varint(value))

// Protobuf's `sint64`, which Hedera uses for transfer amounts: zigzag keeps
// small negative values short instead of sign-extending them.
const zigzag = (value: bigint): bigint =>
  value < 0n ? -2n * value - 1n : 2n * value

const sint64Field = (fieldNumber: number, value: bigint): Uint8Array =>
  varintField(fieldNumber, zigzag(value))

const embedded = (fieldNumber: number, message: Uint8Array): Uint8Array =>
  concat(
    tag(fieldNumber, WIRE_LENGTH_DELIMITED),
    varint(BigInt(message.length)),
    message
  )

// `AccountID` and `TokenID` number their shard, realm and entity fields
// identically, so one helper covers both. Shard and realm are written as
// explicit zeros: Hedera's own SDK emits them, and matching its bytes is what
// lets an off-chain submitter forward a body this signature covers.
const entity = (num: bigint): Uint8Array =>
  concat(
    varintField(ENTITY_SHARD, 0n),
    varintField(ENTITY_REALM, 0n),
    varintField(ENTITY_NUM, num)
  )

const accountAmount = (accountNum: bigint, amount: bigint): Uint8Array =>
  concat(
    embedded(ACCOUNT_AMOUNT_ACCOUNT_ID, entity(accountNum)),
    sint64Field(ACCOUNT_AMOUNT_AMOUNT, amount),
    // `is_approval` false: these transfers always spend the depository's own
    // balance, never an allowance granted to it.
    varintField(ACCOUNT_AMOUNT_IS_APPROVAL, 0n)
  )

// The Hedera SDK orders transfer entries by ascending account number, so the
// debit and credit are emitted in that order rather than debit-first.
//
// The debited account is the depository, not the transaction's payer: the fee is
// charged to the payer outside this list, which is why two entries still net to
// zero.
const transferEntries = (
  senderNum: bigint,
  receiverNum: bigint,
  amount: bigint,
  fieldNumber: number
): Uint8Array => {
  const senderEntry = embedded(fieldNumber, accountAmount(senderNum, -amount))
  const receiverEntry = embedded(
    fieldNumber,
    accountAmount(receiverNum, amount)
  )
  return senderNum < receiverNum
    ? concat(senderEntry, receiverEntry)
    : concat(receiverEntry, senderEntry)
}

const cryptoTransfer = (request: TransferRequest): Uint8Array => {
  if (request.tokenNum === 0n) {
    return embedded(
      CRYPTO_TRANSFER_TRANSFERS,
      transferEntries(
        request.senderNum,
        request.receiverNum,
        request.amount,
        TRANSFER_LIST_ACCOUNT_AMOUNTS
      )
    )
  }

  return concat(
    // Empty HBAR transfer list, written explicitly to match the Hedera SDK.
    embedded(CRYPTO_TRANSFER_TRANSFERS, new Uint8Array(0)),
    embedded(
      CRYPTO_TRANSFER_TOKEN_TRANSFERS,
      concat(
        embedded(TOKEN_TRANSFER_LIST_TOKEN, entity(request.tokenNum)),
        transferEntries(
          request.senderNum,
          request.receiverNum,
          request.amount,
          TOKEN_TRANSFER_LIST_TRANSFERS
        )
      )
    )
  )
}

// The numeric form of a withdrawal, matching the contract's
// `HederaTransferRequest`.
interface TransferRequest {
  payerNum: bigint
  senderNum: bigint
  receiverNum: bigint
  amount: bigint
  tokenNum: bigint
  nodeAccountNum: bigint
  validStartSeconds: bigint
  validStartNanos: number
  validDurationSeconds: number
  maxTransactionFee: bigint
}

/**
 * Serializes the Hedera `TransactionBody` for a withdrawal — the exact bytes
 * the allocator's signature covers.
 *
 * A submitter must wrap these bytes in a `SignedTransaction` verbatim.
 * Rebuilding an equivalent transaction with the Hedera SDK would produce a
 * different body only if the transfer differed, but any such body would not be
 * covered by the signature, so the bytes must be forwarded rather than
 * regenerated.
 */
export const getHederaVmTransactionBody = (
  withdrawal: Withdrawal
): Uint8Array => {
  const request = toTransferRequest(withdrawal)
  return concat(
    embedded(
      BODY_TRANSACTION_ID,
      concat(
        embedded(
          TRANSACTION_ID_VALID_START,
          concat(
            varintField(TIMESTAMP_SECONDS, request.validStartSeconds),
            varintField(TIMESTAMP_NANOS, BigInt(request.validStartNanos))
          )
        ),
        embedded(TRANSACTION_ID_ACCOUNT_ID, entity(request.payerNum)),
        // Never scheduled and never a child transaction, but written as an
        // explicit false to match the Hedera SDK.
        varintField(TRANSACTION_ID_SCHEDULED, 0n)
      )
    ),
    embedded(BODY_NODE_ACCOUNT_ID, entity(request.nodeAccountNum)),
    varintField(BODY_TRANSACTION_FEE, request.maxTransactionFee),
    embedded(
      BODY_VALID_DURATION,
      varintField(DURATION_SECONDS, BigInt(request.validDurationSeconds))
    ),
    // Empty memo, written explicitly to match the Hedera SDK.
    embedded(BODY_MEMO, new Uint8Array(0)),
    embedded(BODY_CRYPTO_TRANSFER, cryptoTransfer(request))
  )
}

// ====== Field conversions ======

// Hedera addresses accounts and tokens as `shard.realm.num` entity ids, but the
// payload carries bare entity numbers. Only long-zero (shard 0 / realm 0)
// entities convert: an account alias carries no entity id, and transferring to
// one would make Hedera auto-create a hollow account — account creation the
// protocol has not approved, and an extra fee the depository would pay.
const toEntityNum = (value: string, field: string): bigint => {
  const address = parseHederaAddress(value)
  if (address.kind !== "entity-id") {
    throw new Error(
      `hedera-vm: ${field} must be an account id (0.0.x), not an account alias; resolve the alias before building a withdrawal`
    )
  }
  return address.entityId.num
}

const fromEntityNum = (num: bigint): string =>
  formatHederaEntityId({ shard: 0n, realm: 0n, num })

const HEDERA_TIMESTAMP_REGEX = /^(0|[1-9][0-9]*)\.([0-9]{9})$/

const toTransferRequest = (withdrawal: Withdrawal): TransferRequest => {
  const validStart = HEDERA_TIMESTAMP_REGEX.exec(withdrawal.validStart)
  if (!validStart) {
    throw new Error(
      `hedera-vm: invalid valid start "${withdrawal.validStart}"; expected seconds.nanoseconds with exactly 9 nanosecond digits`
    )
  }

  return {
    payerNum: toEntityNum(withdrawal.payer, "payer"),
    senderNum: toEntityNum(withdrawal.sender, "sender"),
    receiverNum: toEntityNum(withdrawal.receiver, "receiver"),
    amount: BigInt(withdrawal.amount),
    tokenNum: toEntityNum(withdrawal.token, "token"),
    nodeAccountNum: toEntityNum(withdrawal.nodeAccount, "nodeAccount"),
    validStartSeconds: BigInt(validStart[1]),
    validStartNanos: Number(validStart[2]),
    validDurationSeconds: withdrawal.validDurationSeconds,
    maxTransactionFee: BigInt(withdrawal.maxTransactionFee),
  }
}

export const hederaVmCodec: WithdrawalCodec<Withdrawal> = {
  ...defineAbiWithdrawalCodec({
    params: hederaTransferRequestAbiParams,
    toAbi: (withdrawal: Withdrawal) => {
      const request = toTransferRequest(withdrawal)
      return [
        {
          payerNum: request.payerNum,
          senderNum: request.senderNum,
          receiverNum: request.receiverNum,
          amount: request.amount,
          tokenNum: request.tokenNum,
          nodeAccountNum: request.nodeAccountNum,
          validStartSeconds: request.validStartSeconds,
          validStartNanos: request.validStartNanos,
          validDurationSeconds: request.validDurationSeconds,
          maxTransactionFee: request.maxTransactionFee,
        },
      ]
    },
    fromAbi: ([result]): Withdrawal => ({
      payer: fromEntityNum(result.payerNum),
      sender: fromEntityNum(result.senderNum),
      receiver: fromEntityNum(result.receiverNum),
      amount: result.amount.toString(),
      token: fromEntityNum(result.tokenNum),
      nodeAccount: fromEntityNum(result.nodeAccountNum),
      validStart: `${result.validStartSeconds}.${String(
        result.validStartNanos
      ).padStart(9, "0")}`,
      validDurationSeconds: Number(result.validDurationSeconds),
      maxTransactionFee: result.maxTransactionFee.toString(),
    }),
  }),

  // Hedera verifies ECDSA secp256k1 signatures over the keccak256 digest of the
  // serialized transaction body, so the digest is the value to sign.
  getId: (withdrawal) => keccak256(getHederaVmTransactionBody(withdrawal)),

  // The token id is already the currency identity: `0.0.0` for HBAR (the
  // native-currency sentinel) and the HTS token id otherwise.
  getCurrency: (withdrawal) => withdrawal.token,
  getAmount: (withdrawal) => withdrawal.amount,
  getRecipient: (withdrawal) => withdrawal.receiver,
}
