import { NetworkConfig } from "@relay-protocol/types"

export const apex: NetworkConfig = {
  chainId: 70700n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "70700",
  isTestnet: false,
  name: "Apex",
  relaySolverChainId: 70700,
  rpc: process.env.RPC_70700
    ? [process.env.RPC_70700]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "apex",
}
