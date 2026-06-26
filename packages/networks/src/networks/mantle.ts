import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const mantle: NetworkConfig = {
  chainId: 5000n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0xa4DA4Ec0558404CebBA46Bd112663723BC89829B" },
  },
  family: "ethereum-vm",
  hubChainId: "5000",
  isTestnet: false,
  name: "Mantle",
  rpc: process.env.RPC_5000
    ? [process.env.RPC_5000]
    : ["https://rpc.mantle.xyz"],
  slug: "mantle",
}
