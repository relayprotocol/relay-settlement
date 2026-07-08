import { VmType } from "../../../utils"
import { WithdrawalCodec } from "./codec"
import { bitcoinVmCodec, DecodedBitcoinVmWithdrawal } from "./bitcoin-vm"
import { DecodedEthereumVmWithdrawal, ethereumVmCodec } from "./ethereum-vm"
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
  DecodedHyperliquidVmWithdrawal,
  DecodedLighterVmWithdrawal,
  DecodedSolanaVmWithdrawal,
  DecodedTonVmWithdrawal,
  DecodedTronVmWithdrawal,
  DecodedXrpVmWithdrawal,
  LighterTransferParams,
}
export { buildLighterTransferL1Message } from "./lighter-vm"
export { WithdrawalCodec, defineAbiWithdrawalCodec } from "./codec"

export type DecodedWithdrawal =
  | DecodedEthereumVmWithdrawal
  | DecodedSolanaVmWithdrawal
  | DecodedBitcoinVmWithdrawal
  | DecodedTronVmWithdrawal
  | DecodedHyperliquidVmWithdrawal
  | DecodedLighterVmWithdrawal
  | DecodedTonVmWithdrawal
  | DecodedXrpVmWithdrawal

export type DecodedWithdrawalFor<V extends VmType> = Extract<
  DecodedWithdrawal,
  { vmType: V }
>

// The mapped type forces every VmType to provide a codec of the matching
// payload type: adding a new VmType in utils.ts without registering a codec
// here (or registering one with a mismatched payload) is a compile error.
const codecs: {
  [V in VmType]: WithdrawalCodec<DecodedWithdrawalFor<V>["withdrawal"]>
} = {
  "bitcoin-vm": bitcoinVmCodec,
  "ethereum-vm": ethereumVmCodec,
  "hyperliquid-vm": hyperliquidVmCodec,
  "lighter-vm": lighterVmCodec,
  "solana-vm": solanaVmCodec,
  "ton-vm": tonVmCodec,
  "tron-vm": tronVmCodec,
  "xrp-vm": xrpVmCodec,
}

export const getWithdrawalCodec = <V extends VmType>(
  vmType: V
): WithdrawalCodec<DecodedWithdrawalFor<V>["withdrawal"]> => {
  const codec = codecs[vmType]
  // Unreachable for type-checked callers; preserves the historical runtime
  // error for untyped callers passing an unknown vm type.
  if (!codec) {
    throw new Error("Unsupported vm type")
  }
  // TS cannot relate the mapped-type lookup to the generic return type.
  return codec as WithdrawalCodec<DecodedWithdrawalFor<V>["withdrawal"]>
}
