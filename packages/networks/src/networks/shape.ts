import { NetworkConfig } from "@relay-protocol/types"

export const shape: NetworkConfig = {
  chainId: 360n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "360",
  isTestnet: false,
  name: "Shape",
  relaySolverChainId: 360,
  rpc: process.env.RPC_360
    ? [process.env.RPC_360]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "shape",
}
