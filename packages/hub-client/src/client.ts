import { ChainType } from '@relay-protocol/types'

export interface MintParams {
  family: ChainType
  account: string
  chainId: number
  tokenAddress: string
  amount: bigint
}

export class HubClient {
  chainId: number
  address: string

  constructor({ chainId, address }: { chainId: number; address: string }) {
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
}
