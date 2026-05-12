import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const story: NetworkConfig = {
  chainId: 1514n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "1514",
  isTestnet: false,
  name: "Story",
  rpc: process.env.RPC_1514
    ? [process.env.RPC_1514]
    : ["https://mainnet.storyrpc.io"],
  slug: "story",
}
