import { ChainType } from '@relay-protocol/types'

export interface MintParams {
  family: ChainType
  account: string
  chainId: bigint
  tokenAddress: string
  amount: bigint
}

export interface BurnParams {
  family: ChainType
  account: string
  chainId: bigint
  tokenAddress: string
  amount: bigint
}

export interface TransferFromParams {
  family: ChainType
  account: string
  chainId: bigint
  tokenAddress: string
  amount: bigint
  recipientAddress: string
}

export interface SetOperatorForParams {
  family: ChainType
  account: string
  chainId: bigint
  operatorAddress: string
  approved: boolean
}

export class HubClient {
  chainId: bigint
  address: string

  constructor({ chainId, address }: { chainId: bigint; address: string }) {
    this.chainId = chainId
    this.address = address
  }

  // Declare method signatures (but not implementations)
  mint!: (params: MintParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
  burn!: (params: BurnParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
  setOperatorFor!: (params: SetOperatorForParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
  transferFrom!: (params: TransferFromParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
}
