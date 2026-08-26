import { VmType } from "../../../utils"
import { WithdrawalCodec } from "./codec"
import { bitcoinVmCodec, DecodedBitcoinVmWithdrawal } from "./bitcoin-vm"
import { DecodedEthereumVmWithdrawal, ethereumVmCodec } from "./ethereum-vm"
import {
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  GatewayTransferSpec,
  gatewayVmCodec,
  GatewayVmWithdrawal,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
} from "./gateway-vm"
import { DecodedHederaVmWithdrawal, hederaVmCodec } from "./hedera-vm"
import {
  DecodedHyperliquidVmWithdrawal,
  hyperliquidVmCodec,
} from "./hyperliquid-vm"
import {
  DecodedLighterVmWithdrawal,
  lighterVmCodec,
  LighterTransferParams,
} from "./lighter-vm"
import { DecodedSolanaVmWithdrawal, solanaVmCodec } from "./solana-vm"
import { DecodedTonVmWithdrawal, tonVmCodec } from "./ton-vm"
import { DecodedTronVmWithdrawal, tronVmCodec } from "./tron-vm"
import { DecodedXrpVmWithdrawal, xrpVmCodec } from "./xrp-vm"

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
  LighterTransferParams,
}
export { buildLighterTransferL1Message } from "./lighter-vm"
export { getHederaVmTransactionBody } from "./hedera-vm"
export { WithdrawalCodec, defineAbiWithdrawalCodec } from "./codec"

export type DecodedWithdrawal =
  | DecodedEthereumVmWithdrawal
  | DecodedGatewayVmWithdrawal
  | DecodedSolanaVmWithdrawal
  | DecodedBitcoinVmWithdrawal
  | DecodedHederaVmWithdrawal
  | DecodedTronVmWithdrawal
  | DecodedHyperliquidVmWithdrawal
  | DecodedLighterVmWithdrawal
  | DecodedTonVmWithdrawal
  | DecodedXrpVmWithdrawal

export type DecodedWithdrawalFor<V extends VmType> = Extract<
  DecodedWithdrawal,
  { vmType: V }
>

// VM types whose identity codecs have shipped but whose depository withdrawal
// payload has not. A withdrawal payload mirrors the `abi.encode` of a specific
// on-chain payload builder, so it can only be written once that contract
// exists; listing a VM type here is how it gains address/token identity support
// without a placeholder codec that would encode payloads no allocator can sign.
// Empty today — every VM type has a payload builder.
export type PendingWithdrawalVmType = never

// VM types that can encode a depository withdrawal.
export type WithdrawalVmType = Exclude<VmType, PendingWithdrawalVmType>

// The mapped type forces every WithdrawalVmType to provide a codec of the
// matching payload type: adding a new VmType in utils.ts without either
// registering a codec here or listing it in PendingWithdrawalVmType (and
// registering one with a mismatched payload) is a compile error.
const codecs: {
  [V in WithdrawalVmType]: WithdrawalCodec<
    DecodedWithdrawalFor<V>["withdrawal"]
  >
} = {
  "bitcoin-vm": bitcoinVmCodec,
  "ethereum-vm": ethereumVmCodec,
  "gateway-vm": gatewayVmCodec,
  "hedera-vm": hederaVmCodec,
  "hyperliquid-vm": hyperliquidVmCodec,
  "lighter-vm": lighterVmCodec,
  "solana-vm": solanaVmCodec,
  "ton-vm": tonVmCodec,
  "tron-vm": tronVmCodec,
  "xrp-vm": xrpVmCodec,
}

export const getWithdrawalCodec = <V extends WithdrawalVmType>(
  vmType: V
): WithdrawalCodec<DecodedWithdrawalFor<V>["withdrawal"]> => {
  const codec = codecs[vmType]
  // Unreachable for type-checked callers; preserves the historical runtime
  // error for untyped callers passing an unknown vm type, or one whose
  // withdrawal payload has not shipped yet (see PendingWithdrawalVmType).
  if (!codec) {
    throw new Error("Unsupported vm type")
  }
  // TS cannot relate the mapped-type lookup to the generic return type.
  return codec as WithdrawalCodec<DecodedWithdrawalFor<V>["withdrawal"]>
}
