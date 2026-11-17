import { Hex, keccak256, parseAbiParameters, stringToHex } from "viem"

import {
  AbiValues,
  decodeUnderSchema,
  defineAbiWithdrawalCodec,
  WithdrawalCodec,
} from "./codec"

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

const TRANSFER_REQUEST_TUPLE =
  "(uint64 nonce, uint64 fromAccountIndex, uint64 fromRouteType, uint64 apiKeyIndex, uint64 toAccountIndex, uint64 toRouteType, uint64 assetIndex, uint64 amount, uint64 usdcFee, uint64 lighterChainId, bytes32 memo)"

// Mirrors LighterVmPayloadBuilder.sol `abi.encode(uint8 actionType, LighterTransferRequest)`:
// the action type word followed by the static request inline
const payloadAbiParams = parseAbiParameters(
  `uint8 actionType, ${TRANSFER_REQUEST_TUPLE} parameters` as const
)

// The envelope `abi.encode((uint8 actionType, bytes parameters))` around
// `abi.encode(LighterTransferRequest)`, still stored for payloads built before
// the builder inlined the request
const legacyEnvelopeAbiParams = parseAbiParameters([
  "(uint8 actionType, bytes parameters)",
])

const transferAbiParams = parseAbiParameters([TRANSFER_REQUEST_TUPLE])

type TransferRequestAbi = AbiValues<typeof transferAbiParams>[0]

const transferToAbi = (
  parameters: LighterTransferParams
): TransferRequestAbi => ({
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
})

const transferFromAbi = (
  result: TransferRequestAbi
): LighterTransferParams => ({
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
})

const transferCodec = defineAbiWithdrawalCodec({
  params: transferAbiParams,
  toAbi: (parameters: LighterTransferParams) => [transferToAbi(parameters)],
  fromAbi: ([result]) => transferFromAbi(result),
})

const abiCodec = defineAbiWithdrawalCodec({
  params: payloadAbiParams,
  toAbi: ({ actionType, parameters }: Withdrawal) => [
    actionType,
    transferToAbi(parameters),
  ],
  fromAbi: ([actionType, parameters]): Withdrawal => ({
    actionType,
    parameters: transferFromAbi(parameters),
  }),
})

const legacyAbiCodec = defineAbiWithdrawalCodec({
  params: legacyEnvelopeAbiParams,
  toAbi: ({ actionType, parameters }: Withdrawal) => [
    { actionType, parameters: transferCodec.encode(parameters) as Hex },
  ],
  fromAbi: ([{ actionType, parameters }]): Withdrawal => ({
    actionType,
    parameters: transferCodec.decode(parameters),
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
  encode: abiCodec.encode,

  // Payloads stored before the request was inlined keep the envelope layout;
  // both carry the same request, so the id is preserved
  decode: (encodedWithdrawal) => {
    const withdrawal =
      decodeUnderSchema(abiCodec, encodedWithdrawal) ??
      decodeUnderSchema(legacyAbiCodec, encodedWithdrawal)
    if (!withdrawal) {
      throw new Error("Failed to decode lighter-vm payload")
    }

    if (withdrawal.actionType !== 0) {
      throw new Error(
        `Unsupported Lighter action type: ${withdrawal.actionType}`
      )
    }

    return withdrawal
  },

  getId: (withdrawal) =>
    keccak256(
      stringToHex(buildLighterTransferL1Message(withdrawal.parameters))
    ),

  getCurrency: (withdrawal) => withdrawal.parameters.assetIndex,
  getAmount: (withdrawal) => withdrawal.parameters.amount,
  getRecipient: (withdrawal) => withdrawal.parameters.toAccountIndex,
}
