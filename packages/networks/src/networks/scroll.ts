import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const scroll: NetworkConfig = {
  chainId: 534352n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "534352",
  isTestnet: false,
  name: "Scroll",
  rpc: process.env.RPC_534352
    ? [process.env.RPC_534352]
    : ["https://rpc.scroll.io"],
  slug: "scroll",
}
