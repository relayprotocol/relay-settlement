import { NetworkConfig } from "@relay-protocol/types"

export const arbitrum: NetworkConfig = {
  chainId: 42161n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "42161",
  isTestnet: false,
  name: "Arbitrum",
  rpc: process.env.RPC_42161
    ? [process.env.RPC_42161]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "arbitrum",
}
