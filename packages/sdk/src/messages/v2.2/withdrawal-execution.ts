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

// --- V1 ----

// TODO: Remove once all traffic is switched to v2

export interface SubmitWithdrawRequest {
  chainId: string // The chain id to withdraw on
  depository: string // The depository contract address on the withdrawal chain
  currency: string // The currency to withdraw
  amount: string // The amount to withdraw
  spender: string // The address of the account that owns the balance in the Hub contract (can be an alias)
  receiver: string // The withdrawal recipient
  data: string // Additional data
  nonce: string // Nonce for replay protection
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
        receiver: request.receiver,
        data: request.data as Hex,
        nonce: request.nonce as Hex,
      },
    ]
  )

  return keccak256(encoded)
}

export type WithdrawalAddressParams = {
  depository: string
  depositoryChainId: string
  currency: string
  recipient: string
  withdrawerAlias: string
  withdrawalNonce: string
}

/**
 * Compute deterministic withdrawal address
 *
 * @param depository the depository contract holding the funds on origin chain (as string)
 * @param depositoryChainId the chain id of the depository contract currently holding the funds
 * @param currency the id of the currency as expressed on origin chain (string)
 * @param recipient the address that will receive the withdrawn funds on destination chain
 * @param withdrawerAlias the address that owns the balance on the settlement chain
 * before the withdrawal is initiated
 * @param withdrawalNonce nonce to prevent collisions for similar withdrawals
 * @returns withdrawal address (in lower case)
 */
export function getWithdrawalAddress(
  withdrawalParams: WithdrawalAddressParams & { depositoryVmType: VmType }
): string {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "bytes", "bytes", "address", "bytes32"],
      [
        withdrawalParams.depositoryChainId,
        arrayToHex(
          encodeAddress(
            withdrawalParams.depository,
            withdrawalParams.depositoryVmType
          )
        ),
        arrayToHex(
          encodeAddress(
            withdrawalParams.currency,
            withdrawalParams.depositoryVmType
          )
        ),
        arrayToHex(
          encodeAddress(
            withdrawalParams.recipient,
            withdrawalParams.depositoryVmType
          )
        ),
        withdrawalParams.withdrawerAlias as `0x${string}`,
        `0x${BigInt(withdrawalParams.withdrawalNonce).toString(16).padStart(64, "0")}`,
      ]
    )
  )

  // get 40 bytes for an address
  const withdrawalAddress = hash.slice(2).slice(-40).toLowerCase()
  return `0x${withdrawalAddress}` as `0x${string}`
}

export function getOrderAddress(data: {
  depositChainVmType: VmType
  depositChainId: string
  depositor: string
  depositTimestamp: bigint
  depositId: string
}): string {
  const hash = keccak256(
    encodePacked(
      ["string", "bytes", "uint256", "bytes32"],
      [
        data.depositChainId,
        arrayToHex(encodeAddress(data.depositor, data.depositChainVmType)),
        BigInt(data.depositTimestamp),
        data.depositId as Hex,
      ]
    )
  )

  const orderAddress = hash.slice(2).slice(-40)
  return `0x${orderAddress}` as `0x${string}`
}

// compute a message about withdrawer balance
// to be signed as auth proof for the oracle
export function computeWithdrawerBalanceMessage(
  withdrawerAlias: string,
  amount: bigint,
  withdrawalNonce: string
) {
  return keccak256(
    encodePacked(
      ["address", "uint256", "bytes32"],
      [
        withdrawerAlias as `0x${string}`,
        BigInt(amount),
        withdrawalNonce as `0x${string}`,
      ]
    )
  )
}

// for oracle requests, we replace the hub chain id by a slug used in the oracle (e.g. 'base')
// nb: withdrawer is called 'owner' on the solver
export type WithdrawalAddressRequest = Omit<
  WithdrawalAddressParams,
  "depositoryChainId" | "amount" | "depository" | "withdrawerAlias"
> & {
  withdrawer: string
  withdrawerChainId: string
  chainId: string
}

// types for oracle routes
export type WithdrawalInitiationMessage = {
  data: WithdrawalAddressRequest & {
    expectedAmount: string
    settlementChainId: string
    signature: string
  }
  result: {
    withdrawalAddress: string
  }
}

export type WithdrawalInitiatedMessage = {
  data: WithdrawalAddressRequest & {
    expectedAmount: string
    settlementChainId: string
  }
  result: {
    proofOfWithdrawalAddressBalance: string
    withdrawalAddress: string
  }
}

// types for Hub routes
export type OnChainWithdrawalQuery = {
  data: {
    chainId: string
    payloadId: string
    payloadParams: SubmitWithdrawRequest
  }
  result: {
    encodedData: string
    signature?: string
    signer?: string
  }
}

export type OnchainWithdrawalRequest = {
  data: {
    chainId: string
    currency: string
    amount: string
    recipient: string
    spender: string
    nonce: string
    additionalData?: {
      "hyperliquid-vm"?: {
        currencyHyperliquidSymbol: string
      }
    }
    signature: string
    owner: string
    ownerChainId: string // not needed
  }
  result: {
    id: string
    encodedData: string
    payloadId: string
    submitWithdrawalRequestParams: SubmitWithdrawRequest
    signer: string
  }
}

export type OnchainWithdrawalSignatureRequest = {
  data: {
    chainId: string
    payloadId: string
    payloadParams: SubmitWithdrawRequest
  }
  result: {
    message: string
  }
}

// --- V2 ----

export interface SubmitWithdrawRequestV2 {
  chainId: string // The chain id to withdraw on
  depository: string // The depository contract address on the withdrawal chain
  currency: string // The currency to withdraw
  amount: string // The amount to withdraw
  spender: string // The address of the account that owns the balance in the Hub contract (can be an alias)
  recipient: string // The withdrawal recipient
  nonce: string // Nonce for replay protection
  data: string // Additional data
}

export type DenormalizedSubmitWithdrawRequestV2 = Omit<
  SubmitWithdrawRequestV2,
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

export const getSubmitWithdrawRequestHashV2 = (
  request: SubmitWithdrawRequestV2
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

export type WithdrawalAddressParamsV2 = {
  vmType: VmType
  chainId: string
  depository: string
  currency: string
  recipient: string
  ownerAlias: string
  nonce: string
}

export function getWithdrawalAddressV2(
  withdrawalParams: WithdrawalAddressParamsV2
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

export type OrderAddressParamsV2 = {
  vmType: VmType
  chainId: string
  depositor: string
  timestamp: bigint
  depositId: string
}

export function getOrderAddressV2(orderParams: OrderAddressParamsV2): Address {
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

export function normalizePayloadParamsV2(
  request: DenormalizedSubmitWithdrawRequestV2 & { vmType: VmType }
): SubmitWithdrawRequestV2 {
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
