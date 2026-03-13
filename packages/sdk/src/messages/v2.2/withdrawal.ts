import { PublicKey } from "@solana/web3.js"
import * as bitcoin from "bitcoinjs-lib"
import TronWeb from "tronweb"
import {
  Hex,
  Address,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  keccak256,
} from "viem"

import { arrayToHex } from "../../hub/hub-utils"
import { encodeAddress, getVmTypeNativeCurrency, VmType } from "../../utils"

export interface SubmitWithdrawRequest {
  chainId: string // The chain id to withdraw on
  depository: string // The depository contract address on the withdrawal chain
  currency: string // The currency to withdraw
  amount: string // The amount to withdraw
  spender: string // The address of the account that owns the balance in the Hub contract (can be an alias)
  recipient: string // The withdrawal recipient
  nonce: string // Nonce for replay protection
  data: string // Additional data
}

export type DenormalizedSubmitWithdrawRequest = Omit<
  SubmitWithdrawRequest,
  "data"
> & {
  additionalData?: {
    "bitcoin-vm"?: {
      allocatorUtxos: {
        txid: string
        vout: number
        value: string
      }[]
      feeRate: number
    }
    "hyperliquid-vm"?: {
      currencyHyperliquidSymbol: string
      currentTime: number
    }
  }
}

export const getSubmitWithdrawRequestHash = (
  request: SubmitWithdrawRequest
) => {
  const encoded = encodeAbiParameters(
    parseAbiParameters([
      "(uint256 chainId, string depository, string currency, uint256 amount, address spender, string receiver, bytes data, bytes32 nonce)",
    ]),
    [
      {
        chainId: BigInt(request.chainId),
        depository: request.depository,
        currency: request.currency,
        amount: BigInt(request.amount),
        spender: request.spender as Address,
        receiver: request.recipient,
        data: request.data as Hex,
        nonce: request.nonce as Hex,
      },
    ]
  )

  return keccak256(encoded)
}

export type WithdrawalAddressParams = {
  vmType: VmType
  chainId: string
  depository: string
  currency: string
  recipient: string
  ownerAlias: string
  nonce: string
}

export function getWithdrawalAddress(
  withdrawalParams: WithdrawalAddressParams
): Address {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "bytes", "bytes", "address", "bytes32"],
      [
        withdrawalParams.chainId,
        arrayToHex(
          encodeAddress(withdrawalParams.depository, withdrawalParams.vmType)
        ),
        arrayToHex(
          encodeAddress(withdrawalParams.currency, withdrawalParams.vmType)
        ),
        arrayToHex(
          encodeAddress(withdrawalParams.recipient, withdrawalParams.vmType)
        ),
        withdrawalParams.ownerAlias as Address,
        `0x${BigInt(withdrawalParams.nonce).toString(16).padStart(64, "0")}`,
      ]
    )
  )

  // Get 40 bytes for an address
  const withdrawalAddress = hash.slice(2).slice(-40).toLowerCase()
  return `0x${withdrawalAddress}`
}

export type OrderAddressParams = {
  vmType: VmType
  chainId: string
  depositor: string
  timestamp: bigint
  depositId: string
}

export function getOrderAddress(orderParams: OrderAddressParams): Address {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "uint256", "bytes32"],
      [
        orderParams.chainId,
        arrayToHex(encodeAddress(orderParams.depositor, orderParams.vmType)),
        orderParams.timestamp,
        orderParams.depositId as Hex,
      ]
    )
  )

  // Get 40 bytes for an address
  const orderAddress = hash.slice(2).slice(-40)
  return `0x${orderAddress}`
}

export function normalizePayloadParams(
  request: DenormalizedSubmitWithdrawRequest & { vmType: VmType }
): SubmitWithdrawRequest {
  const defaultParams = {
    chainId: request.chainId,
    depository: request.depository,
    currency: request.currency,
    spender: request.spender,
    recipient: request.recipient,
    amount: request.amount,
    nonce: request.nonce,
    data: "0x",
  }

  switch (request.vmType) {
    case "ethereum-vm": {
      return {
        ...defaultParams,
        depository: defaultParams.depository.toLowerCase(),
        currency: defaultParams.currency.toLowerCase(),
        spender: defaultParams.spender.toLowerCase(),
        recipient: defaultParams.recipient.toLowerCase(),
      }
    }

    case "bitcoin-vm": {
      const bitcoinAdditionalData = request.additionalData?.["bitcoin-vm"]
      if (!bitcoinAdditionalData) {
        throw new Error("Additional data is required for bitcoin-vm")
      }

      const allocatorScriptPubKey = `0x${bitcoin.address
        .toOutputScript(request.depository, bitcoin.networks.bitcoin)
        .toString("hex")}` as Hex

      const toLittleEndianTxid = (txid: string): Hex => {
        const normalizedTxid = txid.startsWith("0x") ? txid.slice(2) : txid
        if (!/^[0-9a-fA-F]{64}$/.test(normalizedTxid)) {
          throw new Error("Invalid bitcoin UTXO txid")
        }

        return `0x${Buffer.from(normalizedTxid, "hex")
          .reverse()
          .toString("hex")}` as Hex
      }

      const data = encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              {
                type: "tuple[]",
                name: "utxos",
                components: [
                  { type: "bytes32", name: "txid" },
                  { type: "uint32", name: "index" },
                  { type: "uint64", name: "value" },
                  { type: "bytes", name: "scriptPubKey" },
                ],
              },
              { type: "uint64", name: "feeRate" },
            ],
          },
        ],
        [
          {
            utxos: bitcoinAdditionalData.allocatorUtxos.map((utxo) => ({
              txid: toLittleEndianTxid(utxo.txid),
              index: utxo.vout,
              value: BigInt(utxo.value),
              scriptPubKey: allocatorScriptPubKey,
            })),
            feeRate: BigInt(bitcoinAdditionalData.feeRate!),
          },
        ]
      )

      return {
        ...defaultParams,
        recipient: bitcoin.address
          .toOutputScript(request.recipient, bitcoin.networks.bitcoin)
          .toString("base64"),
        data,
      }
    }

    case "tron-vm": {
      // The "tron-vm" payload builder (which is the "ethereum-vm" one) expects addresses to be hex-encoded
      const toHex = (address: string) =>
        TronWeb.utils.address
          .toHex(address)
          .replace(TronWeb.utils.address.ADDRESS_PREFIX_REGEX, "0x")
      return {
        ...defaultParams,
        depository: toHex(request.depository),
        currency: toHex(request.currency),
        recipient: toHex(request.recipient),
      }
    }

    case "solana-vm": {
      // The "solana-vm" payload builder expects addresses to be hex-encoded
      const toHexString = (address: string) =>
        new PublicKey(address).toBuffer().toString("hex")
      return {
        ...defaultParams,
        currency:
          request.currency === getVmTypeNativeCurrency(request.vmType)
            ? ""
            : toHexString(request.currency),
        recipient: toHexString(request.recipient),
      }
    }

    case "hyperliquid-vm": {
      const hyperliquidAdditionalData =
        request.additionalData?.["hyperliquid-vm"]
      if (!hyperliquidAdditionalData) {
        throw new Error("Additional data is required for hyperliquid-vm")
      }

      const isNativeCurrency =
        request.currency === getVmTypeNativeCurrency(request.vmType)

      // TODO: We probably shouldn't be letting the user choose the time in order
      // to preserve the assumption that the time is always incrementing. However
      // at the moment we need these for deterministic payload ids.
      const currentTime = BigInt(
        request.additionalData!["hyperliquid-vm"]!.currentTime ?? Date.now()
      )
      const currencyDex =
        request.currency.slice(34) === ""
          ? "spot"
          : Buffer.from(request.currency.slice(34), "hex").toString("ascii")
      const data = isNativeCurrency
        ? encodeAbiParameters([{ type: "uint64" }], [currentTime])
        : encodeAbiParameters(
            [{ type: "uint64" }, { type: "string" }, { type: "string" }],
            [currentTime, currencyDex, currencyDex]
          )

      return {
        ...defaultParams,
        currency: isNativeCurrency
          ? ""
          : `${
              hyperliquidAdditionalData.currencyHyperliquidSymbol
            }:${request.currency.toLowerCase()}`,
        data,
      }
    }

    default: {
      throw new Error("Vm type not implemented for payload params")
    }
  }
}
