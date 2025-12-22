import { NetworkConfig } from "@relay-settlement/types"

export const zero: NetworkConfig = {
  chainId: 543210n,
  contracts: {
    prod: { depository: "0xa88Cf7864951147a08707eD732237EAa9B1C3b9B" },
  },
  family: "ethereum-vm",
  hubChainId: "543210",
  isTestnet: false,
  name: "Zero",
  rpc: process.env.RPC_543210
    ? [process.env.RPC_543210]
    : ["https://rpc.zerion.io/v1/zero"],
  slug: "zero",
}
