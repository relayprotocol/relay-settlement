import { hashStruct } from "viem"

import {
  ChainIdToVmType,
  encodeAddressToHex,
  encodeBytesToHex,
  getChainVmType,
  VmType,
} from "../../utils"

import {
  DecodedWithdrawal,
  DecodedWithdrawalFor,
  getWithdrawalCodec,
} from "./withdrawals"

// Re-exported for backward compatibility: these historically lived in this
// module and are imported from here both by the package root and directly.
export {
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  DecodedLighterVmWithdrawal,
  DecodedSolanaVmWithdrawal,
  DecodedTonVmWithdrawal,
  DecodedTronVmWithdrawal,
  DecodedWithdrawal,
  DecodedWithdrawalFor,
  LighterTransferParams,
  buildLighterTransferL1Message,
  getWithdrawalCodec,
} from "./withdrawals"

export enum DepositoryWithdrawalStatus {
  PENDING = 0,
  EXECUTED = 1,
  EXPIRED = 2,
}

export type DepositoryWithdrawalMessage = {
  data: {
    chainId: string
    withdrawal: string
  }
  result: {
    withdrawalId: string
    depository: string
    status: DepositoryWithdrawalStatus
  }
}

export const getDepositoryWithdrawalMessageId = (
  message: DepositoryWithdrawalMessage,
  chainsConfig: ChainIdToVmType
) => {
  const vmType = (chainId: string) => getChainVmType(chainId, chainsConfig)

  return hashStruct({
    types: {
      DepositoryWithdrawal: [
        { name: "data", type: "Data" },
        { name: "result", type: "Result" },
      ],
      Data: [
        { name: "chainId", type: "string" },
        { name: "withdrawal", type: "bytes" },
      ],
      Result: [
        { name: "withdrawalId", type: "bytes32" },
        { name: "depository", type: "bytes" },
        { name: "status", type: "uint8" },
      ],
    },
    primaryType: "DepositoryWithdrawal",
    data: {
      data: {
        chainId: message.data.chainId,
        withdrawal: encodeBytesToHex(message.data.withdrawal),
      },
      result: {
        withdrawalId: encodeBytesToHex(message.result.withdrawalId),
        depository: encodeAddressToHex(
          message.result.depository,
          vmType(message.data.chainId)
        ),
        status: message.result.status,
      },
    },
  })
}

// Encoding / decoding utilities
//
// The per-VM implementations live in ./withdrawals/<vm>.ts; the functions
// below just dispatch to the codec registered for the withdrawal's vm type.

export const encodeWithdrawal = (
  decodedWithdrawal: DecodedWithdrawal
): string =>
  getWithdrawalCodec(decodedWithdrawal.vmType).encode(
    decodedWithdrawal.withdrawal
  )

export const decodeWithdrawal = <V extends VmType>(
  encodedWithdrawal: string,
  vmType: V
): DecodedWithdrawalFor<V> => {
  const withdrawal = getWithdrawalCodec(vmType).decode(encodedWithdrawal)
  return { vmType, withdrawal } as DecodedWithdrawalFor<V>
}

export const getDecodedWithdrawalId = (
  decodedWithdrawal: DecodedWithdrawal
): string =>
  getWithdrawalCodec(decodedWithdrawal.vmType).getId(
    decodedWithdrawal.withdrawal
  )

export const getDecodedWithdrawalCurrency = (
  decodedWithdrawal: DecodedWithdrawal
): string =>
  getWithdrawalCodec(decodedWithdrawal.vmType).getCurrency(
    decodedWithdrawal.withdrawal
  )

export const getDecodedWithdrawalAmount = (
  decodedWithdrawal: DecodedWithdrawal
): string =>
  getWithdrawalCodec(decodedWithdrawal.vmType).getAmount(
    decodedWithdrawal.withdrawal
  )

export const getDecodedWithdrawalRecipient = (
  decodedWithdrawal: DecodedWithdrawal
): string =>
  getWithdrawalCodec(decodedWithdrawal.vmType).getRecipient(
    decodedWithdrawal.withdrawal
  )
