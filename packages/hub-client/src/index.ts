import { HubClient, MintParams, SubmitTxParams } from './client'
import { submitTx } from './submitTx'
import { prepareMintTx, mint } from './methods/mint'

// Use function expressions to maintain 'this' context
export function createHubClient(params: { chainId: number; address: string }) {
  const client = new HubClient(params)

  // Directly attach methods to the instance
  return Object.assign(client, {
    mint: (mintParams: MintParams) => mint(mintParams, client),
    prepareMintTx: (mintParams: MintParams) =>
      prepareMintTx(mintParams, client),
    submitTx: (txParams: SubmitTxParams) => submitTx(txParams, client),
  })
}

export default HubClient
