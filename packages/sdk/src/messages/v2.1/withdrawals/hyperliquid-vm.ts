import { hashStruct, Hex, parseAbiParameters, parseUnits } from "viem"

import { getVmTypeNativeCurrency } from "../../../utils"
import {
  decodeUnderSchema,
  defineAbiWithdrawalCodec,
  WithdrawalCodec,
} from "./codec"

export type DecodedHyperliquidVmWithdrawal = {
  vmType: "hyperliquid-vm"
  withdrawal: {
    txType: number
    parameters:
      | {
          type: "UsdSend"
          hyperliquidChain: string
          destination: string
          amount: string
          time: string
        }
      | {
          type: "SendAsset"
          hyperliquidChain: string
          destination: string
          sourceDex: string
          destinationDex: string
          token: string
          amount: string
          fromSubAccount: string
          nonce: string
        }
  }
}

type Withdrawal = DecodedHyperliquidVmWithdrawal["withdrawal"]
type UsdSendParameters = Extract<Withdrawal["parameters"], { type: "UsdSend" }>
type SendAssetParameters = Extract<
  Withdrawal["parameters"],
  { type: "SendAsset" }
>

// Mirrors HyperliquidVmPayloadBuilder.sol: the transaction type word followed
// directly by the request fields, `abi.encode(uint8 txType, <request fields>...)`
const usdSendPayloadAbiParams = parseAbiParameters(
  "uint8 txType, string hyperliquidChain, string destination, string amount, uint64 time"
)

const sendAssetPayloadAbiParams = parseAbiParameters(
  "uint8 txType, string hyperliquidChain, string destination, string sourceDex, string destinationDex, string token, string amount, string fromSubAccount, uint64 nonce"
)

// The envelope `abi.encode((uint8 txType, bytes parameters))` around
// `abi.encode(<request>)`, still stored for payloads built before the builder
// inlined the request
const legacyEnvelopeAbiParams = parseAbiParameters([
  "(uint8 txType, bytes parameters)",
])

const usdSendAbiParams = parseAbiParameters([
  "(string hyperliquidChain, string destination, string amount, uint64 time)",
])

const sendAssetAbiParams = parseAbiParameters([
  "(string hyperliquidChain, string destination, string sourceDex, string destinationDex, string token, string amount, string fromSubAccount, uint64 nonce)",
])

const usdSendCodec = defineAbiWithdrawalCodec({
  params: usdSendAbiParams,
  toAbi: (parameters: UsdSendParameters) => [
    {
      hyperliquidChain: parameters.hyperliquidChain,
      destination: parameters.destination,
      amount: parameters.amount,
      time: BigInt(parameters.time),
    },
  ],
  fromAbi: ([result]) => ({
    type: "UsdSend" as const,
    hyperliquidChain: result.hyperliquidChain,
    destination: result.destination,
    amount: result.amount,
    time: result.time.toString(),
  }),
})

const sendAssetCodec = defineAbiWithdrawalCodec({
  params: sendAssetAbiParams,
  toAbi: (parameters: SendAssetParameters) => [
    {
      hyperliquidChain: parameters.hyperliquidChain,
      destination: parameters.destination,
      sourceDex: parameters.sourceDex,
      destinationDex: parameters.destinationDex,
      token: parameters.token,
      amount: parameters.amount,
      fromSubAccount: parameters.fromSubAccount,
      nonce: BigInt(parameters.nonce),
    },
  ],
  fromAbi: ([result]) => ({
    type: "SendAsset" as const,
    hyperliquidChain: result.hyperliquidChain,
    destination: result.destination,
    sourceDex: result.sourceDex,
    destinationDex: result.destinationDex,
    token: result.token,
    amount: result.amount,
    fromSubAccount: result.fromSubAccount,
    nonce: result.nonce.toString(),
  }),
})

const usdSendPayloadCodec = defineAbiWithdrawalCodec({
  params: usdSendPayloadAbiParams,
  toAbi: (withdrawal: Withdrawal & { parameters: UsdSendParameters }) => {
    const { txType, parameters } = withdrawal
    return [
      txType,
      parameters.hyperliquidChain,
      parameters.destination,
      parameters.amount,
      BigInt(parameters.time),
    ]
  },
  fromAbi: ([txType, hyperliquidChain, destination, amount, time]) => ({
    txType,
    parameters: {
      type: "UsdSend" as const,
      hyperliquidChain,
      destination,
      amount,
      time: time.toString(),
    },
  }),
})

const sendAssetPayloadCodec = defineAbiWithdrawalCodec({
  params: sendAssetPayloadAbiParams,
  toAbi: (withdrawal: Withdrawal & { parameters: SendAssetParameters }) => {
    const { txType, parameters } = withdrawal
    return [
      txType,
      parameters.hyperliquidChain,
      parameters.destination,
      parameters.sourceDex,
      parameters.destinationDex,
      parameters.token,
      parameters.amount,
      parameters.fromSubAccount,
      BigInt(parameters.nonce),
    ]
  },
  fromAbi: ([
    txType,
    hyperliquidChain,
    destination,
    sourceDex,
    destinationDex,
    token,
    amount,
    fromSubAccount,
    nonce,
  ]) => ({
    txType,
    parameters: {
      type: "SendAsset" as const,
      hyperliquidChain,
      destination,
      sourceDex,
      destinationDex,
      token,
      amount,
      fromSubAccount,
      nonce: nonce.toString(),
    },
  }),
})

const legacyAbiCodec = defineAbiWithdrawalCodec({
  params: legacyEnvelopeAbiParams,
  toAbi: ({ txType, parameters }: Withdrawal) => [
    {
      txType,
      parameters: (parameters.type === "UsdSend"
        ? usdSendCodec.encode(parameters)
        : sendAssetCodec.encode(parameters)) as Hex,
    },
  ],
  fromAbi: ([{ txType, parameters }]): Withdrawal => {
    switch (txType) {
      case 0: {
        return { txType, parameters: usdSendCodec.decode(parameters) }
      }

      case 1: {
        return { txType, parameters: sendAssetCodec.decode(parameters) }
      }

      default: {
        throw new Error(`Unsupported Hyperliquid transaction type: ${txType}`)
      }
    }
  },
})

// The transaction type each request is signed under
const TX_TYPES = { UsdSend: 0, SendAsset: 1 } as const

export const hyperliquidVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: (withdrawal) => {
    const { txType, parameters } = withdrawal

    switch (parameters.type) {
      case "UsdSend": {
        return usdSendPayloadCodec.encode({ txType, parameters })
      }

      case "SendAsset": {
        return sendAssetPayloadCodec.encode({ txType, parameters })
      }

      default: {
        throw new Error(
          `Unsupported Hyperliquid transaction type ${(parameters as any).type}`
        )
      }
    }
  },

  // The leading type word selects the layout; payloads stored before the
  // request was inlined keep the envelope layout and the same signed request
  decode: (encodedWithdrawal) => {
    const withdrawal =
      decodeUnderSchema(usdSendPayloadCodec, encodedWithdrawal) ??
      decodeUnderSchema(sendAssetPayloadCodec, encodedWithdrawal) ??
      decodeUnderSchema(legacyAbiCodec, encodedWithdrawal)
    if (!withdrawal) {
      throw new Error("Failed to decode hyperliquid-vm payload")
    }

    if (withdrawal.txType !== TX_TYPES[withdrawal.parameters.type]) {
      throw new Error(
        `Unsupported Hyperliquid transaction type: ${withdrawal.txType}`
      )
    }

    return withdrawal
  },

  getId: (withdrawal) => {
    const { parameters } = withdrawal

    switch (parameters.type) {
      case "UsdSend": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:UsdSend": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "amount", type: "string" },
              { name: "time", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:UsdSend",
          data: {
            hyperliquidChain: parameters.hyperliquidChain,
            destination: parameters.destination,
            amount: parameters.amount,
            time: BigInt(parameters.time),
          },
        })
      }

      case "SendAsset": {
        return hashStruct({
          types: {
            "HyperliquidTransaction:SendAsset": [
              { name: "hyperliquidChain", type: "string" },
              { name: "destination", type: "string" },
              { name: "sourceDex", type: "string" },
              { name: "destinationDex", type: "string" },
              { name: "token", type: "string" },
              { name: "amount", type: "string" },
              { name: "fromSubAccount", type: "string" },
              { name: "nonce", type: "uint64" },
            ],
          },
          primaryType: "HyperliquidTransaction:SendAsset",
          data: {
            hyperliquidChain: parameters.hyperliquidChain,
            destination: parameters.destination,
            sourceDex: parameters.sourceDex,
            destinationDex: parameters.destinationDex,
            token: parameters.token,
            amount: parameters.amount,
            fromSubAccount: parameters.fromSubAccount,
            nonce: BigInt(parameters.nonce),
          },
        })
      }

      default: {
        throw new Error(
          `Unsupported Hyperliquid transaction type ${(parameters as any).type}`
        )
      }
    }
  },

  getCurrency: (withdrawal) => {
    const { parameters } = withdrawal

    switch (parameters.type) {
      case "UsdSend": {
        return getVmTypeNativeCurrency("hyperliquid-vm")
      }

      case "SendAsset": {
        const SPOT_USDC = "0x6d1e7cde53ba9467b783cb7c530ce054"

        const tokenAddress = parameters.token.split(":")[1].toLowerCase()
        const tokenDex = parameters.sourceDex
        if (tokenDex === "" && tokenAddress !== SPOT_USDC) {
          throw new Error("Only USDC is supported as a Perps token")
        }

        return tokenDex === "spot"
          ? tokenAddress.toLowerCase()
          : tokenDex === ""
            ? getVmTypeNativeCurrency("hyperliquid-vm")
            : tokenAddress.toLowerCase() +
              Buffer.from(tokenDex, "ascii").toString("hex")
      }

      default:
        throw new Error(
          `Unsupported Hyperliquid transaction type ${(parameters as any).type}`
        )
    }
  },

  getAmount: (withdrawal) => {
    // The payload builder includes all target decimals, omitting the point when there are none.
    const { amount } = withdrawal.parameters
    const [, fraction = ""] = amount.split(".")
    return parseUnits(amount, fraction.length).toString()
  },

  getRecipient: (withdrawal) => withdrawal.parameters.destination,
}
