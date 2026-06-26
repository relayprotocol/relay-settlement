import {
  HubClient,
  BurnParams,
  MintParams,
  SetOperatorForParams,
  TransferFromParams,
} from "./client"
import { burn } from "./methods/burn"
import { mint } from "./methods/mint"
import { setOperatorFor } from "./methods/set-operator-for"
import { transferFrom } from "./methods/transfer-from"

// Use function expressions to maintain 'this' context
export function createHubClient(params: { chainId: string; address: string }) {
  const client = new HubClient(params)

  // Directly attach methods to the instance
  return Object.assign(client, {
    burn: (burnParams: BurnParams) => burn(burnParams),
    mint: (mintParams: MintParams) => mint(mintParams),
    setOperatorFor: (setOperatorForParams: SetOperatorForParams) =>
      setOperatorFor(setOperatorForParams),
    transferFrom: (transferFromParams: TransferFromParams) =>
      transferFrom(transferFromParams),
  })
}

export default HubClient
