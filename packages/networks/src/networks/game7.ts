import { NetworkConfig } from "@relay-protocol/types"

export const game7: NetworkConfig = {
  chainId: 2187n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "2187",
  isTestnet: false,
  name: "Game7",
  relaySolverChainId: 2187,
  rpc: process.env.RPC_2187
    ? [process.env.RPC_2187]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "game7",
}
