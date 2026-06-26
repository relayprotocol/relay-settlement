import {
  decodeAbiParameters,
  encodeAbiParameters,
  hashStruct,
  Hex,
  parseAbiParameters,
  parseUnits,
} from "viem"

import { getVmTypeNativeCurrency } from "../../../utils"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "./codec"

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

const envelopeAbiParams = parseAbiParameters([
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

export const hyperliquidVmCodec: WithdrawalCodec<Withdrawal> = {
  encode: (withdrawal) => {
    const { txType, parameters } = withdrawal

    let encodedParameters: string
    switch (parameters.type) {
      case "UsdSend": {
        encodedParameters = usdSendCodec.encode(parameters)
        break
      }

      case "SendAsset": {
        encodedParameters = sendAssetCodec.encode(parameters)
        break
      }

      default: {
        throw new Error(
          `Unsupported Hyperliquid transaction type ${(parameters as any).type}`
        )
      }
    }

    return encodeAbiParameters(envelopeAbiParams, [
      {
        txType,
        parameters: encodedParameters as Hex,
      },
    ])
  },

  decode: (encodedWithdrawal) => {
    const result = decodeAbiParameters(
      envelopeAbiParams,
      encodedWithdrawal as Hex
    )

    const { txType, parameters } = result[0]

    switch (txType) {
      case 0: {
        return {
          txType: Number(txType),
          parameters: usdSendCodec.decode(parameters),
        }
      }

      case 1: {
        return {
          txType: Number(txType),
          parameters: sendAssetCodec.decode(parameters),
        }
      }

      default: {
        throw new Error(`Unsupported Hyperliquid transaction type: ${txType}`)
      }
    }
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
    // The assumption here is that the amount is always encoded with the full decimals of the currency
    const decimals = withdrawal.parameters.amount.split(".")[1].length
    return parseUnits(withdrawal.parameters.amount, decimals).toString()
  },

  getRecipient: (withdrawal) => withdrawal.parameters.destination,
}
