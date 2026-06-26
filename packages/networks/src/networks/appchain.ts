import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const appchain: NetworkConfig = {
  chainId: 466n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "466",
  isTestnet: false,
  name: "Appchain",
  rpc: process.env.RPC_466
    ? [process.env.RPC_466]
    : ["https://rpc.appchain.xyz/http"],
  slug: "appchain",
}
