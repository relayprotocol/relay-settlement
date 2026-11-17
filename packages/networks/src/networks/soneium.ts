import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const soneium: NetworkConfig = {
  chainId: 1868n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "1868",
  isTestnet: false,
  name: "Soneium",
  ...resolveRpc(process.env.RPC_1868, ["https://rpc.soneium.org"]),
  slug: "soneium",
}
