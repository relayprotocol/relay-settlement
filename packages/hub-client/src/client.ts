import { VmType } from "@relay-protocol/settlement-sdk"

export interface MintParams {
  family: VmType
  account: string
  chainId: string
  tokenAddress: string
  amount: bigint
}

export interface BurnParams {
  family: VmType
  account: string
  chainId: string
  tokenAddress: string
  amount: bigint
}

export interface TransferFromParams {
  family: VmType
  account: string
  chainId: string
  tokenAddress: string
  amount: bigint
  recipientAddress: string
}

export interface SetOperatorForParams {
  family: VmType
  account: string
  chainId: string
  operatorAddress: string
  approved: boolean
}

export class HubClient {
  chainId: string
  address: string

  constructor({ chainId, address }: { chainId: string; address: string }) {
    this.chainId = chainId
    this.address = address
  }

  // Declare method signatures (but not implementations)

  mint!: (_params: MintParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>

  burn!: (_params: BurnParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>

  setOperatorFor!: (_params: SetOperatorForParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>

  transferFrom!: (_params: TransferFromParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
}
