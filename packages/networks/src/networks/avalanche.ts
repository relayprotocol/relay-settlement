import { NetworkConfig } from "@relay-protocol/types"

export const avalanche: NetworkConfig = {
  chainId: 43114n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "43114",
  isTestnet: false,
  name: "Avalanche",
  rpc: process.env.RPC_43114
    ? [process.env.RPC_43114]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "avalanche",
}
