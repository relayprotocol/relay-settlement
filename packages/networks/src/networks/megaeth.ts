import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const megaeth: NetworkConfig = {
  chainId: 4326n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "4326",
  isTestnet: false,
  name: "MegaETH",
  ...resolveRpc(process.env.RPC_4326, ["https://mainnet.megaeth.com/rpc"]),
  slug: "megaeth",
}
