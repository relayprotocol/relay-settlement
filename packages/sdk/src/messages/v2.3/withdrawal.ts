import { Hex, encodeAbiParameters, parseAbiParameters, keccak256 } from "viem"
import * as bitcoin from "bitcoinjs-lib"

import { encodeAddressToHex, VmType } from "../../utils"

export interface WithdrawRequest {
  chainId: string // The chain id to withdraw on
  depository: string // Standard-encoded address of the depository on the withdrawal chain
  currency: string // Standard-encoded address of the currency to be withdrawn
  amount: string // The amount to withdraw
  spenderChainId: string // The chain id of the spender
  spender: string // Standard-encoded address of the spender
  receiver: string // Payload-builder custom-encoded address of the receiver of the withdrawn funds
  nonce: string // Nonce for replay protection
  data: string // Additional data
}

export type BitcoinVmWithdrawRequestAdditionalData = {
  allocatorUtxos: {
    txid: string
    vout: number
    value: string
  }[]
  feeUtxos: {
    txid: string
    vout: number
    value: string
    address: string
  }[]
  feeRate: number
  feeChangeAddress: string
}

export type HyperliquidVmWithdrawRequestAdditionalData = {
  nonce: number | bigint | string
}

export type LighterVmWithdrawRequestAdditionalData = {
  nonce: number | bigint | string
  apiKeyIndex: number | bigint | string
  usdcFee: number | bigint | string
}

export type XrpVmWithdrawRequestAdditionalData = {
  sequence: number
  fee: number | bigint | string // drops
  lastLedgerSequence: number
  flags?: number
  destinationTag?: number
}

export type WithdrawRequestAdditionalData = {
  "bitcoin-vm"?: BitcoinVmWithdrawRequestAdditionalData
  "hyperliquid-vm"?: HyperliquidVmWithdrawRequestAdditionalData
  "lighter-vm"?: LighterVmWithdrawRequestAdditionalData
  "xrp-vm"?: XrpVmWithdrawRequestAdditionalData
}

export type DenormalizedWithdrawRequest = Omit<WithdrawRequest, "data"> & {
  additionalData?: WithdrawRequestAdditionalData
}

// Mirrors `RelayExecutor.Fee`
export type ExecuteAndWithdrawFee = {
  recipient: string // Hub account (alias) that receives the fee
  amount: string // Fee amount denominated in the input currency
}

// Mirrors `RelayExecutor.ExecuteAndWithdrawRequest`
export type ExecuteAndWithdrawRequest = {
  inChainId: string
  inCurrency: string
  outChainId: string
  outCurrency: string
  outAmountMinimum: string
  depository: string
  orderAddress: string
  receiver: string
  data: string
  fees: ExecuteAndWithdrawFee[]
  nonce: string
  deadline: string
}

export const getWithdrawRequestHash = (request: WithdrawRequest) => {
  const encoded = encodeAbiParameters(
    parseAbiParameters([
      "(string chainId, bytes depository, bytes currency, uint256 amount, string spenderChainId, bytes spender, bytes receiver, bytes data, bytes32 nonce)",
    ]),
    [
      {
        chainId: request.chainId,
        depository: request.depository as Hex,
        currency: request.currency as Hex,
        amount: BigInt(request.amount),
        spenderChainId: request.spenderChainId,
        spender: request.spender as Hex,
        receiver: request.receiver as Hex,
        data: request.data as Hex,
        nonce: request.nonce as Hex,
      },
    ]
  )

  return keccak256(encoded)
}

export function normalizeWithdrawRequest(
  request: DenormalizedWithdrawRequest & {
    vmType: VmType
    spenderVmType: VmType
  }
): WithdrawRequest {
  switch (request.vmType) {
    case "bitcoin-vm": {
      const bitcoinAdditionalData = request.additionalData?.["bitcoin-vm"]
      if (!bitcoinAdditionalData) {
        throw new Error("Additional data is required for bitcoin-vm")
      }

      const toLittleEndianTxid = (txid: string): Hex => {
        const normalizedTxid = txid.startsWith("0x") ? txid.slice(2) : txid
        if (!/^[0-9a-fA-F]{64}$/.test(normalizedTxid)) {
          throw new Error("Invalid bitcoin UTXO txid")
        }

        return `0x${Buffer.from(normalizedTxid, "hex")
          .reverse()
          .toString("hex")}` as Hex
      }
      const toScriptPubKey = (address: string): Hex =>
        `0x${bitcoin.address
          .toOutputScript(address, bitcoin.networks.bitcoin)
          .toString("hex")}` as Hex
      const toAllocatorScriptPubKey = (address: string): Hex => {
        const scriptPubKey = toScriptPubKey(address)
        const script = Buffer.from(scriptPubKey.slice(2), "hex")
        if (script.length !== 22 || script[0] !== 0x00 || script[1] !== 0x14) {
          throw new Error("bitcoin-vm allocator must be a P2WPKH address")
        }

        return scriptPubKey
      }
      const allocatorScriptPubKey = toAllocatorScriptPubKey(request.depository)

      const data = encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              {
                type: "tuple[]",
                name: "allocatorUtxos",
                components: [
                  { type: "bytes32", name: "txid" },
                  { type: "uint32", name: "index" },
                  { type: "uint64", name: "value" },
                  { type: "bytes", name: "scriptPubKey" },
                ],
              },
              {
                type: "tuple[]",
                name: "feeUtxos",
                components: [
                  { type: "bytes32", name: "txid" },
                  { type: "uint32", name: "index" },
                  { type: "uint64", name: "value" },
                  { type: "bytes", name: "scriptPubKey" },
                ],
              },
              { type: "bytes", name: "feeChangeScript" },
              { type: "uint64", name: "feeRate" },
            ],
          },
        ],
        [
          {
            allocatorUtxos: bitcoinAdditionalData.allocatorUtxos.map(
              (utxo) => ({
                txid: toLittleEndianTxid(utxo.txid),
                index: utxo.vout,
                value: BigInt(utxo.value),
                scriptPubKey: allocatorScriptPubKey,
              })
            ),
            feeUtxos: bitcoinAdditionalData.feeUtxos.map((utxo) => ({
              txid: toLittleEndianTxid(utxo.txid),
              index: utxo.vout,
              value: BigInt(utxo.value),
              scriptPubKey: toScriptPubKey(utxo.address),
            })),
            feeChangeScript: toScriptPubKey(
              bitcoinAdditionalData.feeChangeAddress
            ),
            feeRate: BigInt(bitcoinAdditionalData.feeRate),
          },
        ]
      )

      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data,
        nonce: request.nonce,
      }
    }

    case "hyperliquid-vm": {
      const hyperliquidAdditionalData =
        request.additionalData?.["hyperliquid-vm"]
      if (!hyperliquidAdditionalData) {
        throw new Error("Additional data is required for hyperliquid-vm")
      }

      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeAbiParameters(
          [{ type: "uint64" }],
          [BigInt(hyperliquidAdditionalData.nonce)]
        ),
        nonce: request.nonce,
      }
    }

    case "lighter-vm": {
      const lighterAdditionalData = request.additionalData?.["lighter-vm"]
      if (!lighterAdditionalData) {
        throw new Error("Additional data is required for lighter-vm")
      }
      if (lighterAdditionalData.nonce === undefined) {
        throw new Error("nonce is required in lighter-vm additionalData")
      }
      if (lighterAdditionalData.apiKeyIndex === undefined) {
        throw new Error("apiKeyIndex is required in lighter-vm additionalData")
      }
      if (lighterAdditionalData.usdcFee === undefined) {
        throw new Error("usdcFee is required in lighter-vm additionalData")
      }
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeAbiParameters(
          [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
          [
            BigInt(lighterAdditionalData.nonce),
            BigInt(lighterAdditionalData.apiKeyIndex),
            BigInt(lighterAdditionalData.usdcFee),
          ]
        ),
        nonce: request.nonce,
      }
    }

    case "xrp-vm": {
      const xrpAdditionalData = request.additionalData?.["xrp-vm"]
      if (!xrpAdditionalData) {
        throw new Error("Additional data is required for xrp-vm")
      }
      if (xrpAdditionalData.sequence === undefined) {
        throw new Error("sequence is required in xrp-vm additionalData")
      }
      if (xrpAdditionalData.fee === undefined) {
        throw new Error("fee is required in xrp-vm additionalData")
      }
      if (xrpAdditionalData.lastLedgerSequence === undefined) {
        throw new Error(
          "lastLedgerSequence is required in xrp-vm additionalData"
        )
      }

      // XrpVmPayloadBuilder decodes `data` as `abi.decode(data, (XrpRequestData))`
      const data = encodeAbiParameters(
        parseAbiParameters([
          "(uint32 sequence, uint64 fee, uint32 lastLedgerSequence, uint32 flags, uint32 destinationTag, bool hasDestinationTag)",
        ]),
        [
          {
            sequence: xrpAdditionalData.sequence,
            fee: BigInt(xrpAdditionalData.fee),
            lastLedgerSequence: xrpAdditionalData.lastLedgerSequence,
            flags: xrpAdditionalData.flags ?? 0,
            destinationTag: xrpAdditionalData.destinationTag ?? 0,
            hasDestinationTag: xrpAdditionalData.destinationTag !== undefined,
          },
        ]
      )

      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data,
        nonce: request.nonce,
      }
    }

    case "ethereum-vm":
    case "solana-vm":
    case "ton-vm":
    case "tron-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: "0x",
        nonce: request.nonce,
      }
    }

    default: {
      throw new Error("Vm type not implemented normalizeWithdrawRequest")
    }
  }
}
