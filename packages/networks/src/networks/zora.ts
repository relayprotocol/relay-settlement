import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

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
    : ["https://rpc.zora.energy"],
  slug: "zora",
}
