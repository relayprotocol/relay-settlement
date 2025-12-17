import { NetworkConfig } from "@relay-settlement/types"

export const zora: NetworkConfig = {
  chainId: 7777777n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "7777777",
  isTestnet: false,
  name: "Zora",
  rpc: process.env.RPC_7777777
    ? [process.env.RPC_7777777]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "zora",
}
