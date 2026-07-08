import { sha512 } from "@noble/hashes/sha512"
import { encodeForSigning } from "ripple-binary-codec"
import { bytesToHex, Hex, hexToBytes, parseAbiParameters } from "viem"

import {
  decodeAddress,
  encodeAddress,
  getVmTypeNativeCurrency,
} from "../../../utils"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

export type DecodedXrpVmWithdrawal = {
  vmType: "xrp-vm"
  withdrawal: {
    account: string /// sending depository as a classic ("r...") address
    /// receiver as a classic ("r...") address. XRPL also has X-addresses, which
    /// may embed a destination tag; decompose those via `decodeXrpDestination`
    /// so the tag lands in `destinationTag` rather than being dropped.
    destination: string
    amount: string /// drops (native XRP) or issued-currency value
    fee: string /// transaction fee in drops
    sequence: number /// sending account sequence number
    lastLedgerSequence: number /// last ledger the transaction is valid in
    flags: number /// XRPL transaction flags
    signingPubKey: string /// 33-byte signing public key, 0x-prefixed hex
    destinationTag?: number /// optional XRPL destination tag
    /// Issued-currency code (3-char ISO or 160-bit hex). Omit for native XRP.
    /// Reserved for forward compatibility: the payload builder is native-only
    /// in v1, so the codec rejects issued currencies until it gains the
    /// 48-byte issued-`Amount` serialization.
    currency?: string
    /// Issued-currency issuer as a classic ("r...") address. Omit for native XRP.
    issuer?: string
  }
}

type Withdrawal = DecodedXrpVmWithdrawal["withdrawal"]

// The withdrawal shape carries optional currency/issuer for forward
// compatibility, but the payload builder serializes native XRP only in v1.
// Reject issued currencies at encode/hash time rather than emit a payload the
// on-chain builder cannot produce. `currency` and `issuer` must be provided
// together (both identify an issued currency); native XRP omits both.
const assertNativeXrp = (withdrawal: Withdrawal): void => {
  const hasCurrency = withdrawal.currency !== undefined
  const hasIssuer = withdrawal.issuer !== undefined
  if (hasCurrency !== hasIssuer) {
    throw new Error(
      "xrp-vm: issued currencies require both currency and issuer"
    )
  }
  if (hasCurrency || hasIssuer) {
    throw new Error(
      "xrp-vm: issued (non-native) currencies are not yet supported; omit currency/issuer for native XRP"
    )
  }
}

// Mirrors XrpVmPayloadBuilder.sol `abi.encode(XrpPaymentRequest)`. `account`
// and `destination` are the 20-byte AccountIDs (not the classic string form);
// `signingPubKey` is the 33-byte key the allocator signs with. The tag is
// carried as an explicit presence flag so a `DestinationTag` of 0 is
// distinguishable from "no destination tag" (the two serialize differently).
const xrpPaymentRequestAbiParams = parseAbiParameters([
  "(bytes20 account, bytes20 destination, uint64 amount, uint64 fee, uint32 sequence, uint32 lastLedgerSequence, uint32 flags, uint32 destinationTag, bool hasDestinationTag, bytes signingPubKey)",
])

// ====== XRPL transaction signing hash ======

// The allocator signs SHA512Half(0x53545800 || canonically-serialized-tx),
// where 0x53545800 ("STX\0") is the single-signing prefix. `encodeForSigning`
// prepends that prefix and serializes the fields in canonical order; the
// signing hash is the first 32 bytes of the SHA-512 of the result. This
// mirrors `XrpVmPayloadBuilder.hashesToSign` on the contract side.
const getXrpVmWithdrawalSigningHash = (withdrawal: Withdrawal): string => {
  assertNativeXrp(withdrawal)
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Account: withdrawal.account,
    Destination: withdrawal.destination,
    Amount: withdrawal.amount,
    Fee: withdrawal.fee,
    Sequence: withdrawal.sequence,
    LastLedgerSequence: withdrawal.lastLedgerSequence,
    Flags: withdrawal.flags,
    SigningPubKey: withdrawal.signingPubKey.replace(/^0x/, "").toUpperCase(),
  }
  if (withdrawal.destinationTag !== undefined) {
    tx.DestinationTag = withdrawal.destinationTag
  }

  const signingData = encodeForSigning(tx)
  const digest = sha512(hexToBytes(`0x${signingData}`)).slice(0, 32)
  return bytesToHex(digest).toUpperCase().replace(/^0X/, "0x")
}

export const xrpVmCodec: WithdrawalCodec<Withdrawal> = {
  ...defineAbiWithdrawalCodec({
    params: xrpPaymentRequestAbiParams,
    toAbi: (withdrawal: Withdrawal) => {
      assertNativeXrp(withdrawal)
      return [
        {
          account: bytesToHex(encodeAddress(withdrawal.account, "xrp-vm")),
          destination: bytesToHex(
            encodeAddress(withdrawal.destination, "xrp-vm")
          ),
          amount: BigInt(withdrawal.amount),
          fee: BigInt(withdrawal.fee),
          sequence: withdrawal.sequence,
          lastLedgerSequence: withdrawal.lastLedgerSequence,
          flags: withdrawal.flags,
          destinationTag: withdrawal.destinationTag ?? 0,
          hasDestinationTag: withdrawal.destinationTag !== undefined,
          signingPubKey: withdrawal.signingPubKey as Hex,
        },
      ]
    },
    fromAbi: ([result]): Withdrawal => ({
      account: decodeAddress(hexToBytes(result.account as Hex), "xrp-vm"),
      destination: decodeAddress(
        hexToBytes(result.destination as Hex),
        "xrp-vm"
      ),
      amount: result.amount.toString(),
      fee: result.fee.toString(),
      sequence: Number(result.sequence),
      lastLedgerSequence: Number(result.lastLedgerSequence),
      flags: Number(result.flags),
      signingPubKey: result.signingPubKey as Hex,
      ...(result.hasDestinationTag
        ? { destinationTag: Number(result.destinationTag) }
        : {}),
    }),
  }),

  getId: getXrpVmWithdrawalSigningHash,

  // Native XRP only in v1 (issued assets out of scope per XrpVmPayloadBuilder).
  getCurrency: () => getVmTypeNativeCurrency("xrp-vm"),
  getAmount: (withdrawal) => withdrawal.amount,
  getRecipient: (withdrawal) => withdrawal.destination,
}
