import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const mythos: NetworkConfig = {
  chainId: 42018n,
  contracts: {
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "42018",
  isTestnet: false,
  name: "Mythos",
  rpc: process.env.RPC_42018
    ? [process.env.RPC_42018]
    : ["https://chain-rpc.mythicalgames.com"],
  slug: "mythos",
}
