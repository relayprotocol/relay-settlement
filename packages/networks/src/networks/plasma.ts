import { NetworkConfig } from "@relay-protocol/types"

export const plasma: NetworkConfig = {
  chainId: 9745n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "9745",
  isTestnet: false,
  name: "Plasma",
  relaySolverChainId: 9745,
  rpc: process.env.RPC_9745
    ? [process.env.RPC_9745]
    : ["https://rpc.plasma.to"],
  slug: "plasma",
}
