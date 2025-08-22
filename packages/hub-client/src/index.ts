import {
  HubClient,
  BurnParams,
  MintParams,
  SetOperatorForParams,
  TransferFromParams,
} from './client'
import { burn } from './methods/burn'
import { mint } from './methods/mint'
import { setOperatorFor } from './methods/set-operator-for'
import { transferFrom } from './methods/transfer-from'

// Use function expressions to maintain 'this' context
export function createHubClient(params: { chainId: number; address: string }) {
  const client = new HubClient(params)

  // Directly attach methods to the instance
  return Object.assign(client, {
    burn: (burnParams: BurnParams) => burn(burnParams, client),
    mint: (mintParams: MintParams) => mint(mintParams, client),
    setOperatorFor: (setOperatorForParams: SetOperatorForParams) =>
      setOperatorFor(setOperatorForParams, client),
    transferFrom: (transferFromParams: TransferFromParams) =>
      transferFrom(transferFromParams, client),
  })
}

export default HubClient
