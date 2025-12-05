import { NetworkConfig } from "@relay-protocol/types"

export const rari: NetworkConfig = {
  chainId: 1380012617n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1380012617",
  isTestnet: false,
  name: "Rari",
  relaySolverChainId: 1380012617,
  rpc: process.env.RPC_1380012617
    ? [process.env.RPC_1380012617]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "rari",
}
