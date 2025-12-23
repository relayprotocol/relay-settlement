import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const shape: NetworkConfig = {
  chainId: 360n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "360",
  isTestnet: false,
  name: "Shape",
  rpc: process.env.RPC_360
    ? [process.env.RPC_360]
    : ["https://mainnet.shape.network"],
  slug: "shape",
}
