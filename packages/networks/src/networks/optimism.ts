import { NetworkConfig } from "@relay-protocol/types"

export const optimism: NetworkConfig = {
  chainId: 10n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "10",
  isTestnet: false,
  name: "Optimism",
  relaySolverChainId: 10,
  rpc: process.env.RPC_10
    ? [process.env.RPC_10]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "optimism",
}
