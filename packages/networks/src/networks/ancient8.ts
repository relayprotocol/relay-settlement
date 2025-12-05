import { NetworkConfig } from "@relay-protocol/types"

export const ancient8: NetworkConfig = {
  chainId: 888888888n,
  contracts: {
    prod: {
      depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
    },
  },
  family: "ethereum-vm",
  hubChainId: "888888888",
  isTestnet: false,
  name: "Ancient8",
  relaySolverChainId: 888888888,
  rpc: process.env.RPC_888888888
    ? [process.env.RPC_888888888]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "ancient8",
}
