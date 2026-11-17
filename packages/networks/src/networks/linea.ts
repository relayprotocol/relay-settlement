import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const linea: NetworkConfig = {
  chainId: 59144n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "59144",
  isTestnet: false,
  name: "Linea",
  ...resolveRpc(process.env.RPC_59144, [
    "https://rpc.linea.build",
    "https://linea.drpc.org",
  ]),
  slug: "linea",
}
