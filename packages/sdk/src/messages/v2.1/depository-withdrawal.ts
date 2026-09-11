import {
  DecodedWithdrawal,
  DecodedWithdrawalFor,
  getWithdrawalCodec,
  WithdrawalVmType,
} from "./withdrawals"

// Re-exported for backward compatibility: these historically lived in this
// module and are imported from here both by the package root and directly.
export {
  DecodedBitcoinVmWithdrawal,
  DecodedEthereumVmWithdrawal,
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  GatewayTransferSpec,
  GatewayVmWithdrawal,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
  DecodedHederaVmWithdrawal,
  DecodedHyperliquidVmWithdrawal,
  DecodedLighterVmWithdrawal,
  DecodedSolanaVmWithdrawal,
  DecodedTonVmWithdrawal,
  DecodedTronVmWithdrawal,
  DecodedXrpVmWithdrawal,
  DecodedWithdrawal,
  DecodedWithdrawalFor,
  LighterTransferParams,
  PendingWithdrawalVmType,
  WithdrawalVmType,
  buildLighterTransferL1Message,
  getHederaVmTransactionBody,
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

export const decodeWithdrawal = <V extends WithdrawalVmType>(
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
