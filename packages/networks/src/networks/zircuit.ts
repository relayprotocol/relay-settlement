import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const zircuit: NetworkConfig = {
  chainId: 48900n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "48900",
  isTestnet: false,
  name: "Zircuit",
  rpc: process.env.RPC_48900
    ? [process.env.RPC_48900]
    : ["https://mainnet.zircuit.com"],
  slug: "zircuit",
}
