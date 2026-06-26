import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const taiko: NetworkConfig = {
  chainId: 167000n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "167000",
  isTestnet: false,
  name: "Taiko",
  rpc: process.env.RPC_167000
    ? [process.env.RPC_167000]
    : ["https://rpc.mainnet.taiko.xyz"],
  slug: "taiko",
}
