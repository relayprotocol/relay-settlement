import { NetworkConfig } from "@relay-protocol/types"

export const xai: NetworkConfig = {
  chainId: 660279n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "660279",
  isTestnet: false,
  name: "XAI",
  relaySolverChainId: 660279,
  rpc: process.env.RPC_660279
    ? [process.env.RPC_660279]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "xai",
}
