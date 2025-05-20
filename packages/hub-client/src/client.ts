import { ChainType } from '@relay-protocol/types'

// Mostly copied from ethers.js
export interface SubmitTxParamsOpts {
  gasPrice?: bigint
  maxFeePerBlobGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasLimit?: bigint
  maxFeePerGas?: bigint
  nonce?: bigint
}
export interface SubmitTxParams {
  chainId?: number
  to?: string
  from?: string
  data: string
  value?: bigint
  opts?: SubmitTxParamsOpts
}

export interface MintParams {
  family: ChainType
  account: string
  chaindId: number
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
  submitTx!: (params: SubmitTxParams) => Promise<string>
  mint!: (params: MintParams) => Promise<string>
  prepareMintTx!: (params: MintParams) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
}
