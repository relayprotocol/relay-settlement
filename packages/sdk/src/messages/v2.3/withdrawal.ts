import {
  Address,
  Hex,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  keccak256,
} from "viem"
import * as bitcoin from "bitcoinjs-lib"

import { encodeAddressToHex, VmType } from "../../utils"
import {
  encodeRoutedWithdrawalData,
  hashRoutedCalls,
  ROUTED_WITHDRAWAL_DATA_VERSION,
  RoutedCall,
} from "../common/ethereum-vm/routed"

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

// Mirrors HederaVmPayloadBuilder.sol `HederaRequestData`; `validStartNanos` is
// derived on-chain and deliberately absent.
export type HederaVmWithdrawRequestAdditionalData = {
  payerNum: number | bigint | string
  nodeAccountNum: number | bigint | string
  validStartSeconds: number | bigint | string
  validDurationSeconds: number
  maxTransactionFee: number | bigint | string
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

export type GatewayVmWithdrawRequestAdditionalData = {
  allocator: string
  destinationChainId: string
  maxBlockHeight: number | bigint | string
  destinationData?: GatewayVmDestinationAdditionalData
}

type GatewayVmDestinationAdditionalData = {
  vmType: "ethereum-vm"
  router: string
  calls: RoutedCall[]
}

// Routed withdrawal to an allowlisted router (empty/absent = direct transfer)
export type EthereumVmWithdrawRequestAdditionalData = {
  router: string
  calls: RoutedCall[]
}

export type WithdrawRequestAdditionalData = {
  "bitcoin-vm"?: BitcoinVmWithdrawRequestAdditionalData
  "hedera-vm"?: HederaVmWithdrawRequestAdditionalData
  "hyperliquid-vm"?: HyperliquidVmWithdrawRequestAdditionalData
  "lighter-vm"?: LighterVmWithdrawRequestAdditionalData
  "xrp-vm"?: XrpVmWithdrawRequestAdditionalData
  "gateway-vm"?: GatewayVmWithdrawRequestAdditionalData
  "ethereum-vm"?: EthereumVmWithdrawRequestAdditionalData
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

export const executeAndWithdrawRequestTypes = {
  ExecuteAndWithdrawRequest: [
    { name: "inChainId", type: "string" },
    { name: "inCurrency", type: "bytes" },
    { name: "outChainId", type: "string" },
    { name: "outCurrency", type: "bytes" },
    { name: "outAmountMinimum", type: "uint256" },
    { name: "depository", type: "bytes" },
    { name: "orderAddress", type: "address" },
    { name: "receiver", type: "bytes" },
    { name: "data", type: "bytes" },
    { name: "fees", type: "Fee[]" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  Fee: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const

// Mirrors `RelayExecutor.hashExecuteAndWithdrawRequest` — the digest the
// oracle signs and the key of the funding pool's per-order draw records
export const getExecuteAndWithdrawRequestHash = (
  chainId: number,
  executor: Address,
  request: ExecuteAndWithdrawRequest
) =>
  hashTypedData({
    domain: {
      name: "RelayExecutor",
      version: "1",
      chainId,
      verifyingContract: executor,
    },
    types: executeAndWithdrawRequestTypes,
    primaryType: "ExecuteAndWithdrawRequest",
    message: {
      inChainId: request.inChainId,
      inCurrency: request.inCurrency as Hex,
      outChainId: request.outChainId,
      outCurrency: request.outCurrency as Hex,
      outAmountMinimum: BigInt(request.outAmountMinimum),
      depository: request.depository as Hex,
      orderAddress: request.orderAddress as Address,
      receiver: request.receiver as Hex,
      data: request.data as Hex,
      fees: request.fees.map((fee) => ({
        recipient: fee.recipient as Address,
        amount: BigInt(fee.amount),
      })),
      nonce: request.nonce as Hex,
      deadline: BigInt(request.deadline),
    },
  })

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

export function encodeWithdrawRequestAdditionalData({
  vmType,
  additionalData,
  depository,
}: {
  vmType: VmType
  additionalData?: WithdrawRequestAdditionalData
  depository?: string
}): Hex {
  switch (vmType) {
    case "bitcoin-vm": {
      const bitcoinAdditionalData = additionalData?.["bitcoin-vm"]
      if (!bitcoinAdditionalData) {
        throw new Error("Additional data is required for bitcoin-vm")
      }
      if (!depository) {
        throw new Error("depository is required for bitcoin-vm additionalData")
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
      const allocatorScriptPubKey = toAllocatorScriptPubKey(depository)

      return encodeAbiParameters(
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
    }

    case "hyperliquid-vm": {
      const hyperliquidAdditionalData = additionalData?.["hyperliquid-vm"]
      if (!hyperliquidAdditionalData) {
        throw new Error("Additional data is required for hyperliquid-vm")
      }

      return encodeAbiParameters(
        [{ type: "uint64" }],
        [BigInt(hyperliquidAdditionalData.nonce)]
      )
    }

    case "lighter-vm": {
      const lighterAdditionalData = additionalData?.["lighter-vm"]
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

      return encodeAbiParameters(
        [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
        [
          BigInt(lighterAdditionalData.nonce),
          BigInt(lighterAdditionalData.apiKeyIndex),
          BigInt(lighterAdditionalData.usdcFee),
        ]
      )
    }

    case "xrp-vm": {
      const xrpAdditionalData = additionalData?.["xrp-vm"]
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
      return encodeAbiParameters(
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
    }

    case "gateway-vm": {
      const gatewayAdditionalData = additionalData?.["gateway-vm"]
      if (!gatewayAdditionalData) {
        throw new Error("Additional data is required for gateway-vm")
      }
      if (
        gatewayAdditionalData.destinationData &&
        gatewayAdditionalData.destinationData.vmType !== "ethereum-vm"
      ) {
        throw new Error("Unsupported gateway-vm destination data")
      }
      const destinationData = gatewayAdditionalData.destinationData
        ? encodeRoutedWithdrawalData({
            version: ROUTED_WITHDRAWAL_DATA_VERSION,
            router: gatewayAdditionalData.destinationData.router,
            dataHash: hashRoutedCalls(
              gatewayAdditionalData.destinationData.calls
            ),
          })
        : "0x"

      return encodeAbiParameters(
        parseAbiParameters([
          "(address allocator, string destinationChainId, uint256 maxBlockHeight, bytes destinationData)",
        ]),
        [
          {
            allocator: gatewayAdditionalData.allocator as Hex,
            destinationChainId: gatewayAdditionalData.destinationChainId,
            maxBlockHeight: BigInt(gatewayAdditionalData.maxBlockHeight),
            destinationData,
          },
        ]
      )
    }

    case "ethereum-vm": {
      const ethereumVmAdditionalData = additionalData?.["ethereum-vm"]
      if (!ethereumVmAdditionalData) {
        return "0x"
      }

      // Only the commitment goes on-chain; the caller keeps the calls for execution
      return encodeRoutedWithdrawalData({
        version: ROUTED_WITHDRAWAL_DATA_VERSION,
        router: ethereumVmAdditionalData.router,
        dataHash: hashRoutedCalls(ethereumVmAdditionalData.calls),
      })
    }

    case "hedera-vm": {
      const hederaAdditionalData = additionalData?.["hedera-vm"]
      if (!hederaAdditionalData) {
        throw new Error("Additional data is required for hedera-vm")
      }
      for (const field of [
        "payerNum",
        "nodeAccountNum",
        "validStartSeconds",
        "validDurationSeconds",
        "maxTransactionFee",
      ] as const) {
        if (hederaAdditionalData[field] === undefined) {
          throw new Error(`${field} is required in hedera-vm additionalData`)
        }
      }

      // HederaVmPayloadBuilder decodes `data` as `abi.decode(data, (HederaRequestData))`
      return encodeAbiParameters(
        parseAbiParameters([
          "(uint64 payerNum, uint64 nodeAccountNum, uint64 validStartSeconds, uint32 validDurationSeconds, uint64 maxTransactionFee)",
        ]),
        [
          {
            payerNum: BigInt(hederaAdditionalData.payerNum),
            nodeAccountNum: BigInt(hederaAdditionalData.nodeAccountNum),
            validStartSeconds: BigInt(hederaAdditionalData.validStartSeconds),
            validDurationSeconds: hederaAdditionalData.validDurationSeconds,
            maxTransactionFee: BigInt(hederaAdditionalData.maxTransactionFee),
          },
        ]
      )
    }

    case "solana-vm":
    case "ton-vm":
    case "tron-vm":
      return "0x"

    default:
      throw new Error(
        "Vm type not implemented encodeWithdrawRequestAdditionalData"
      )
  }
}

export function normalizeWithdrawRequest(
  request: DenormalizedWithdrawRequest & {
    vmType: VmType
    spenderVmType: VmType
  }
): WithdrawRequest {
  switch (request.vmType) {
    case "bitcoin-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
          depository: request.depository,
        }),
        nonce: request.nonce,
      }
    }

    case "hyperliquid-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    case "lighter-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    case "xrp-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    case "gateway-vm": {
      return {
        chainId: request.chainId,
        depository: request.depository,
        currency: request.currency,
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: request.receiver,
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    case "ethereum-vm": {
      return {
        chainId: request.chainId,
        depository: encodeAddressToHex(request.depository, request.vmType),
        currency: encodeAddressToHex(request.currency, request.vmType),
        amount: request.amount,
        spenderChainId: request.spenderChainId,
        spender: encodeAddressToHex(request.spender, request.spenderVmType),
        receiver: encodeAddressToHex(request.receiver, request.vmType),
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    case "hedera-vm":
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
        data: encodeWithdrawRequestAdditionalData({
          vmType: request.vmType,
          additionalData: request.additionalData,
        }),
        nonce: request.nonce,
      }
    }

    default: {
      throw new Error("Vm type not implemented normalizeWithdrawRequest")
    }
  }
}
