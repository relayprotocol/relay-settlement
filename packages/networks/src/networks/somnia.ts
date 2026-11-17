import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const somnia: NetworkConfig = {
  chainId: 5031n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "5031",
  isTestnet: false,
  name: "Somnia",
  ...resolveRpc(process.env.RPC_5031, [
    "https://api.infra.mainnet.somnia.network",
  ]),
  slug: "somnia",
}
