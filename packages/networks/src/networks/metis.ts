import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const metis: NetworkConfig = {
  chainId: 1088n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0xa4DA4Ec0558404CebBA46Bd112663723BC89829B" },
  },
  family: "ethereum-vm",
  hubChainId: "1088",
  isTestnet: false,
  name: "Metis",
  rpc: process.env.RPC_1088
    ? [process.env.RPC_1088]
    : ["https://andromeda.metis.io/?owner=1088"],
  slug: "metis",
}
