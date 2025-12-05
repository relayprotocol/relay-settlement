import { NetworkConfig } from "@relay-protocol/types"

export const zircuit: NetworkConfig = {
  chainId: 48900n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "48900",
  isTestnet: false,
  name: "Zircuit",
  relaySolverChainId: 48900,
  rpc: process.env.RPC_48900
    ? [process.env.RPC_48900]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "zircuit",
}
