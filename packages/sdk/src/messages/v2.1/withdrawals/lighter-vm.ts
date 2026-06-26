import {
  decodeAbiParameters,
  encodeAbiParameters,
  Hex,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from "viem"

import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

export type LighterTransferParams = {
  type: "Transfer"
  nonce: string
  fromAccountIndex: string
  fromRouteType: string
  apiKeyIndex: string
  toAccountIndex: string
  toRouteType: string
  assetIndex: string
  amount: string
  usdcFee: string
  lighterChainId: string
  memo: string
}

export type DecodedLighterVmWithdrawal = {
  vmType: "lighter-vm"
  withdrawal: {
    actionType: number
    parameters: LighterTransferParams
  }
}

type Withdrawal = DecodedLighterVmWithdrawal["withdrawal"]

const envelopeAbiParams = parseAbiParameters([
  "(uint8 actionType, bytes parameters)",
])

const transferAbiParams = parseAbiParameters([
  "(uint64 nonce, uint64 fromAccountIndex, uint64 fromRouteType, uint64 apiKeyIndex, uint64 toAccountIndex, uint64 toRouteType, uint64 assetIndex, uint64 amount, uint64 usdcFee, uint64 lighterChainId, bytes32 memo)",
])

const transferCodec = defineAbiWithdrawalCodec({
  params: transferAbiParams,
  toAbi: (parameters: LighterTransferParams) => [
    {
      nonce: BigInt(parameters.nonce),
      fromAccountIndex: BigInt(parameters.fromAccountIndex),
      fromRouteType: BigInt(parameters.fromRouteType),
      apiKeyIndex: BigInt(parameters.apiKeyIndex),
      toAccountIndex: BigInt(parameters.toAccountIndex),
      toRouteType: BigInt(parameters.toRouteType),
      assetIndex: BigInt(parameters.assetIndex),
      amount: BigInt(parameters.amount),
      usdcFee: BigInt(parameters.usdcFee),
      lighterChainId: BigInt(parameters.lighterChainId),
      memo: `0x${parameters.memo.padEnd(64, "0")}` as Hex,
    },
  ],
  fromAbi: ([result]) => ({
    type: "Transfer" as const,
    nonce: result.nonce.toString(),
    fromAccountIndex: result.fromAccountIndex.toString(),
    fromRouteType: result.fromRouteType.toString(),
    apiKeyIndex: result.apiKeyIndex.toString(),
    toAccountIndex: result.toAccountIndex.toString(),
    toRouteType: result.toRouteType.toString(),
    assetIndex: result.assetIndex.toString(),
    amount: result.amount.toString(),
    usdcFee: result.usdcFee.toString(),
    lighterChainId: result.lighterChainId.toString(),
    memo: (result.memo as string).slice(2),
  }),
})

// ====== Lighter L1 message helpers ======

const lighterToHex16 = (val: string): string =>
  "0x" + BigInt(val).toString(16).padStart(16, "0")

/**
 * Reconstructs the Lighter L1 message text for a Transfer operation.
 * Must exactly match lighter-ts SDK wasm-signer-client.ts transfer() format.
 */
export const buildLighterTransferL1Message = (
  w: LighterTransferParams
): string => {
  const memo = w.memo.padEnd(64, "0")

  return [
    "Transfer",
    "",
    `nonce: ${lighterToHex16(w.nonce)}`,
    `from: ${lighterToHex16(w.fromAccountIndex)} (route ${lighterToHex16(w.fromRouteType)})`,
    `api key: ${lighterToHex16(w.apiKeyIndex)}`,
    `to: ${lighterToHex16(w.toAccountIndex)} (route ${lighterToHex16(w.toRouteType)})`,
    `asset: ${lighterToHex16(w.assetIndex)}`,
    `amount: ${lighterToHex16(w.amount)}`,
    `fee: ${lighterToHex16(w.usdcFee)}`,
    `chainId: ${lighterToHex16(w.lighterChainId)}`,
    `memo: ${memo}`,
    "Only sign this message for a trusted client!",
  ].join("\n")
}

export const lighterVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: (withdrawal) => {
    const { actionType, parameters } = withdrawal

    return encodeAbiParameters(envelopeAbiParams, [
      {
        actionType,
        parameters: transferCodec.encode(parameters) as Hex,
      },
    ])
  },

  decode: (encodedWithdrawal) => {
    const result = decodeAbiParameters(
      envelopeAbiParams,
      encodedWithdrawal as Hex
    )

    const { actionType, parameters } = result[0]

    if (actionType !== 0) {
      throw new Error(`Unsupported Lighter action type: ${actionType}`)
    }

    return {
      actionType: Number(actionType),
      parameters: transferCodec.decode(parameters),
    }
  },

  getId: (withdrawal) =>
    keccak256(
      stringToHex(buildLighterTransferL1Message(withdrawal.parameters))
    ),

  getCurrency: (withdrawal) => withdrawal.parameters.assetIndex,
  getAmount: (withdrawal) => withdrawal.parameters.amount,
  getRecipient: (withdrawal) => withdrawal.parameters.toAccountIndex,
}
