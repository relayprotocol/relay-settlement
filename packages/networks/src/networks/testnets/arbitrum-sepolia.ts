import { NetworkConfig } from "@relay-protocol/types"

export const arbitrumSepolia: NetworkConfig = {
  chainId: 421614n,
  family: "ethereum-vm",
  isTestnet: true,
  name: "Arbitrum Sepolia",
  rpc: process.env.RPC_421614
    ? [process.env.RPC_421614]
    : ["https://sepolia-rollup.arbitrum.io/rpc"],
  slug: "arbitrum-sepolia",
}
