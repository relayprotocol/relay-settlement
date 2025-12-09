import { NetworkConfig } from "@relay-protocol/types"

export const stable: NetworkConfig = {
  chainId: 988n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "988",
  isTestnet: false,
  name: "Stable",
  rpc: process.env.RPC_988
    ? [process.env.RPC_988]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "stable",
}
