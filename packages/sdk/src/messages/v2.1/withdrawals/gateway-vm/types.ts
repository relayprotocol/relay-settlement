export type GatewayTransferSpec = {
  version: number
  sourceDomain: number
  destinationDomain: number
  sourceContract: string
  destinationContract: string
  sourceToken: string
  destinationToken: string
  sourceDepositor: string
  destinationRecipient: string
  sourceSigner: string
  destinationCaller: string
  value: string
  salt: string
  hookData: string
}

export type GatewayBurnIntent = {
  maxBlockHeight: string
  maxFee: string
  spec: GatewayTransferSpec
}

export type GatewayVmWithdrawal = {
  destinationChainId: string
  executionPayload: string
  burnIntent: GatewayBurnIntent
}

export type DecodedGatewayVmWithdrawal = {
  vmType: "gateway-vm"
  withdrawal: GatewayVmWithdrawal
}
