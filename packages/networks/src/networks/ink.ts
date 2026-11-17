import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const ink: NetworkConfig = {
  chainId: 57073n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "57073",
  isTestnet: false,
  name: "Ink",
  ...resolveRpc(process.env.RPC_57073, ["https://rpc-gel.inkonchain.com"]),
  slug: "ink",
}
