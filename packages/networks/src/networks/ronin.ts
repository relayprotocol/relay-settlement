import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const ronin: NetworkConfig = {
  chainId: 2020n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "2020",
  isTestnet: false,
  name: "Ronin",
  rpc: process.env.RPC_2020
    ? [process.env.RPC_2020]
    : ["https://api.roninchain.com/rpc"],
  slug: "ronin",
}
