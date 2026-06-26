import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const zora: NetworkConfig = {
  chainId: 7777777n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
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
