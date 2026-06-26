import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const rari: NetworkConfig = {
  chainId: 1380012617n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "1380012617",
  isTestnet: false,
  name: "Rari",
  rpc: process.env.RPC_1380012617
    ? [process.env.RPC_1380012617]
    : ["https://mainnet.rpc.rarichain.org/http"],
  slug: "rari",
}
