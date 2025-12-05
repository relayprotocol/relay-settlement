import { NetworkConfig } from "@relay-protocol/types"

export const blast: NetworkConfig = {
  chainId: 81457n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "81457",
  isTestnet: false,
  name: "Blast",
  relaySolverChainId: 81457,
  rpc: process.env.RPC_81457
    ? [process.env.RPC_81457]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "blast",
}
