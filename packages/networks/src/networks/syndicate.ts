import { NetworkConfig } from "@relay-protocol/types"

export const syndicate: NetworkConfig = {
  chainId: 510003n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "510003",
  isTestnet: false,
  name: "Syndicate",
  relaySolverChainId: 510003,
  rpc: process.env.RPC_510003
    ? [process.env.RPC_510003]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "syndicate",
}
