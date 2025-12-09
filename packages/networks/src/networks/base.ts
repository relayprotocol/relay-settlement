import { NetworkConfig } from "@relay-protocol/types"

export const base: NetworkConfig = {
  chainId: 8453n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "8453",
  isTestnet: false,
  name: "Base",
  relaySolverChainId: 8453,
  rpc: process.env.RPC_8453
    ? [process.env.RPC_8453]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "base",
}
