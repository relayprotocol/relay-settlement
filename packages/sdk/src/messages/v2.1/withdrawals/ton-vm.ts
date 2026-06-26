import {
  Address as TonAddress,
  beginCell,
  internal as tonInternal,
  storeMessageRelaxed,
} from "@ton/core"
import { bytesToHex, Hex, hexToBytes, parseAbiParameters } from "viem"

import {
  decodeAddress,
  encodeAddress,
  getVmTypeNativeCurrency,
} from "../../../utils"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

export type DecodedTonVmWithdrawal = {
  vmType: "ton-vm"
  withdrawal: {
    receiver: string
    amount: string
    createdAt: number
    queryId: number
    subwalletId: number
    timeout: number
  }
}

type Withdrawal = DecodedTonVmWithdrawal["withdrawal"]

// Mirrors TonVmPayloadBuilder.sol `abi.encode(TonTransferRequest)`.
const tonTransferRequestAbiParams = parseAbiParameters([
  "(bytes32 receiver, uint128 amount, uint32 createdAt, uint32 queryId, uint32 subwalletId, uint32 timeout)",
])

// ====== TON Highload V3 msg_inner cell hash ======

// Mirrors `TonVmPayloadBuilder._signingMessageCellHash` and the reference
// vectors in settlement-protocol `tools/tonReferenceHashes.ts`.
//
// Cell layout (149 bits, 1 ref):
//   subwallet_id  uint32
//   ref → MessageRelaxed (native TON transfer, bounce=false)
//   send_mode     uint8   (= 1, PAY_GAS_SEPARATELY; wallet OR's IGNORE_ERRORS)
//   shift         uint13  ┐  HighloadQueryId = (shift << 10) | bit_number
//   bit_number    uint10  ┘
//   created_at    uint64
//   timeout       uint22
const TON_SEND_MODE = 1
const TON_BOUNCE = false

const getTonVmWithdrawalCellHash = (withdrawal: Withdrawal): string => {
  const receiver = TonAddress.parse(withdrawal.receiver)

  const messageCell = beginCell()
    .store(
      storeMessageRelaxed(
        tonInternal({
          to: receiver,
          value: BigInt(withdrawal.amount),
          bounce: TON_BOUNCE,
        })
      )
    )
    .endCell()

  const shift = withdrawal.queryId >>> 10
  const bitNumber = withdrawal.queryId & 0x3ff

  const innerCell = beginCell()
    .storeUint(withdrawal.subwalletId, 32)
    .storeRef(messageCell)
    .storeUint(TON_SEND_MODE, 8)
    .storeUint(shift, 13)
    .storeUint(bitNumber, 10)
    .storeUint(BigInt(withdrawal.createdAt), 64)
    .storeUint(withdrawal.timeout, 22)
    .endCell()

  return "0x" + innerCell.hash().toString("hex")
}

export const tonVmCodec: WithdrawalCodec<Withdrawal> = {
  ...defineAbiWithdrawalCodec({
    params: tonTransferRequestAbiParams,
    toAbi: (withdrawal: Withdrawal) => [
      {
        receiver: bytesToHex(encodeAddress(withdrawal.receiver, "ton-vm")),
        amount: BigInt(withdrawal.amount),
        createdAt: withdrawal.createdAt,
        queryId: withdrawal.queryId,
        subwalletId: withdrawal.subwalletId,
        timeout: withdrawal.timeout,
      },
    ],
    fromAbi: ([result]) => ({
      receiver: decodeAddress(hexToBytes(result.receiver as Hex), "ton-vm"),
      amount: result.amount.toString(),
      createdAt: Number(result.createdAt),
      queryId: Number(result.queryId),
      subwalletId: Number(result.subwalletId),
      timeout: Number(result.timeout),
    }),
  }),

  getId: getTonVmWithdrawalCellHash,

  // Native TON only in v1 (jetton out of scope per TonVmPayloadBuilder.sol).
  getCurrency: () => getVmTypeNativeCurrency("ton-vm"),
  getAmount: (withdrawal) => withdrawal.amount,
  getRecipient: (withdrawal) => withdrawal.receiver,
}
