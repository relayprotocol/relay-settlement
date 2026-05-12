import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const polygonZkevm: NetworkConfig = {
  chainId: 1101n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0xa4DA4Ec0558404CebBA46Bd112663723BC89829B" },
  },
  family: "ethereum-vm",
  hubChainId: "1101",
  isTestnet: false,
  name: "Polygon zkEVM",
  rpc: process.env.RPC_1101
    ? [process.env.RPC_1101]
    : ["https://zkevm-rpc.com"],
  slug: "polygon_zkevm",
}
