import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const plume: NetworkConfig = {
  chainId: 98866n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "98866",
  isTestnet: false,
  name: "Plume",
  rpc: process.env.RPC_98866
    ? [process.env.RPC_98866]
    : ["https://rpc.plume.org"],
  slug: "plume",
}
