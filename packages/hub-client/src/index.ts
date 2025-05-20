import { HubClient, MintParams } from './client'
import { mint } from './methods/mint'

// Use function expressions to maintain 'this' context
export function createHubClient(params: { chainId: number; address: string }) {
  const client = new HubClient(params)

  // Directly attach methods to the instance
  return Object.assign(client, {
    mint: (mintParams: MintParams) => mint(mintParams, client),
  })
}

export default HubClient
