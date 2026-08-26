import { Hex, parseAbiParameters } from "viem"

import { getVmTypeNativeCurrency } from "../../../../utils"
import { defineAbiWithdrawalCodec, WithdrawalCodec } from "../codec"
import {
  getGatewayDestinationCodec,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
} from "./destination"
import {
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  GatewayTransferSpec,
  GatewayVmWithdrawal,
} from "./types"

export {
  DecodedGatewayVmWithdrawal,
  GatewayBurnIntent,
  GatewayTransferSpec,
  GatewayVmWithdrawal,
  getGatewayDestinationExpiration,
  getGatewayDestinationVmType,
}

// Mirrors `GatewayVmPayload` in GatewayVmPayloadBuilder.sol.
const gatewayVmPayloadAbiParams = parseAbiParameters([
  "(string destinationChainId, bytes executionPayload, (uint256 maxBlockHeight, uint256 maxFee, (uint32 version, uint32 sourceDomain, uint32 destinationDomain, bytes32 sourceContract, bytes32 destinationContract, bytes32 sourceToken, bytes32 destinationToken, bytes32 sourceDepositor, bytes32 destinationRecipient, bytes32 sourceSigner, bytes32 destinationCaller, uint256 value, bytes32 salt, bytes hookData) spec) burnIntent)",
])

const gatewayVmAbiCodec = defineAbiWithdrawalCodec<
  typeof gatewayVmPayloadAbiParams,
  GatewayVmWithdrawal
>({
  params: gatewayVmPayloadAbiParams,
  toAbi: (withdrawal: GatewayVmWithdrawal) => [
    {
      destinationChainId: withdrawal.destinationChainId,
      executionPayload: withdrawal.executionPayload as Hex,
      burnIntent: {
        maxBlockHeight: BigInt(withdrawal.burnIntent.maxBlockHeight),
        maxFee: BigInt(withdrawal.burnIntent.maxFee),
        spec: {
          version: withdrawal.burnIntent.spec.version,
          sourceDomain: withdrawal.burnIntent.spec.sourceDomain,
          destinationDomain: withdrawal.burnIntent.spec.destinationDomain,
          sourceContract: withdrawal.burnIntent.spec.sourceContract as Hex,
          destinationContract: withdrawal.burnIntent.spec
            .destinationContract as Hex,
          sourceToken: withdrawal.burnIntent.spec.sourceToken as Hex,
          destinationToken: withdrawal.burnIntent.spec.destinationToken as Hex,
          sourceDepositor: withdrawal.burnIntent.spec.sourceDepositor as Hex,
          destinationRecipient: withdrawal.burnIntent.spec
            .destinationRecipient as Hex,
          sourceSigner: withdrawal.burnIntent.spec.sourceSigner as Hex,
          destinationCaller: withdrawal.burnIntent.spec
            .destinationCaller as Hex,
          value: BigInt(withdrawal.burnIntent.spec.value),
          salt: withdrawal.burnIntent.spec.salt as Hex,
          hookData: withdrawal.burnIntent.spec.hookData as Hex,
        },
      },
    },
  ],
  fromAbi: ([payload]) => ({
    destinationChainId: payload.destinationChainId,
    executionPayload: payload.executionPayload,
    burnIntent: {
      maxBlockHeight: payload.burnIntent.maxBlockHeight.toString(),
      maxFee: payload.burnIntent.maxFee.toString(),
      spec: {
        version: payload.burnIntent.spec.version,
        sourceDomain: payload.burnIntent.spec.sourceDomain,
        destinationDomain: payload.burnIntent.spec.destinationDomain,
        sourceContract: payload.burnIntent.spec.sourceContract,
        destinationContract: payload.burnIntent.spec.destinationContract,
        sourceToken: payload.burnIntent.spec.sourceToken,
        destinationToken: payload.burnIntent.spec.destinationToken,
        sourceDepositor: payload.burnIntent.spec.sourceDepositor,
        destinationRecipient: payload.burnIntent.spec.destinationRecipient,
        sourceSigner: payload.burnIntent.spec.sourceSigner,
        destinationCaller: payload.burnIntent.spec.destinationCaller,
        value: payload.burnIntent.spec.value.toString(),
        salt: payload.burnIntent.spec.salt,
        hookData: payload.burnIntent.spec.hookData,
      },
    },
  }),
})

export const gatewayVmCodec: WithdrawalCodec<GatewayVmWithdrawal> = {
  ...gatewayVmAbiCodec,
  getId: (withdrawal) =>
    getGatewayDestinationCodec(withdrawal).getId(withdrawal.executionPayload),
  getCurrency: () => getVmTypeNativeCurrency("gateway-vm"),
  getAmount: (withdrawal) => withdrawal.burnIntent.spec.value,
  getRecipient: (withdrawal) =>
    getGatewayDestinationCodec(withdrawal).getRecipient(
      withdrawal.executionPayload
    ),
}
