import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const ancient8: NetworkConfig = {
  chainId: 888888888n,
  contracts: {
    prod: {
      depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
    },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "888888888",
  isTestnet: false,
  name: "Ancient8",
  rpc: process.env.RPC_888888888
    ? [process.env.RPC_888888888]
    : ["https://rpc.ancient8.gg"],
  slug: "ancient8",
}
