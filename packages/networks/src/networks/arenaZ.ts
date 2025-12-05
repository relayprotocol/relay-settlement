import { NetworkConfig } from "@relay-protocol/types"

export const arenaZ: NetworkConfig = {
  chainId: 7897n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "7897",
  isTestnet: false,
  name: "Arena Z",
  relaySolverChainId: 7897,
  rpc: process.env.RPC_7897
    ? [process.env.RPC_7897]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "arena_z",
}
