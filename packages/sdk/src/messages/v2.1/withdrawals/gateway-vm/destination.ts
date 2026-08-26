import type { VmType } from "../../../../utils"
import { gatewayEthereumVmDestinationCodec } from "./ethereum-vm"
import type { GatewayTransferSpec, GatewayVmWithdrawal } from "./types"

export interface GatewayDestinationWithdrawalCodec {
  vmType: Exclude<VmType, "gateway-vm">
  matches: (spec: GatewayTransferSpec) => boolean
  getId: (executionPayload: string) => string
  getRecipient: (executionPayload: string) => string
  getExpiration: (executionPayload: string) => number
}

// Destination codecs own the VM-specific execution payload. Adding Solana
// support only requires registering a codec that matches its Circle program.
const destinationCodecs: readonly GatewayDestinationWithdrawalCodec[] = [
  gatewayEthereumVmDestinationCodec,
]

export const getGatewayDestinationCodec = (
  withdrawal: GatewayVmWithdrawal
): GatewayDestinationWithdrawalCodec => {
  const codec = destinationCodecs.find((candidate) =>
    candidate.matches(withdrawal.burnIntent.spec)
  )
  if (!codec) {
    throw new Error(
      `Unsupported Gateway destination contract ${withdrawal.burnIntent.spec.destinationContract} for domain ${withdrawal.burnIntent.spec.destinationDomain}`
    )
  }
  return codec
}

export const getGatewayDestinationVmType = (
  withdrawal: GatewayVmWithdrawal
): Exclude<VmType, "gateway-vm"> =>
  getGatewayDestinationCodec(withdrawal).vmType

export const getGatewayDestinationExpiration = (
  withdrawal: GatewayVmWithdrawal
): number =>
  getGatewayDestinationCodec(withdrawal).getExpiration(
    withdrawal.executionPayload
  )
