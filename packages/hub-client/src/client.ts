import { SubmitTxParams } from './submitTx'

export class HubClient {
  chainId: string
  address: string

  constructor({ chainId, address }: { chainId: string; address: string }) {
    this.chainId = chainId
    this.address = address
  }

  // Declare method signatures (but not implementations)

  submitTx!: (params: SubmitTxParams) => Promise<string>
  mint!: (params: {
    account: string
    chaindId: string
    tokenAddress: string
    amount: number
  }) => Promise<string>
  prepareMintTx!: (params: {
    account: string
    chaindId: string
    tokenAddress: string
    amount: number
  }) => Promise<{
    to: string
    from?: string
    data: string
    value?: string
  }>
}

export default HubClient
