import { submitTx, SubmitTxParams } from '../submitTx'
import HubClient from '../client'

interface MintParams {
  account: string
  chaindId: string
  tokenAddress: string
  amount: number
}

export const mint = async (params: MintParams): Promise<string> => {
  const tx = await prepareMintTx(params)
  return submitTx(tx)
}

export const prepareMintTx = async (
  params: MintParams
): Promise<SubmitTxParams> => {
  // First, create a tokenId param
  // Then, create the virtual address that will hold the token on the Hub
  // Finally construct the transaction object which calls `mint` on the Hub contract
  return {
    chainId: params.chaindId,
    data: 'calldata',
    to: 'hub',
    value: '0',
  }
}

HubClient.prototype.mint = mint
HubClient.prototype.prepareMintTx = prepareMintTx
