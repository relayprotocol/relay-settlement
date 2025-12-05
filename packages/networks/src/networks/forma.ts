import { NetworkConfig } from "@relay-protocol/types"

export const forma: NetworkConfig = {
  chainId: 984122n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "984122",
  isTestnet: false,
  name: "Forma",
  relaySolverChainId: 984122,
  rpc: process.env.RPC_984122
    ? [process.env.RPC_984122]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "forma",
}
