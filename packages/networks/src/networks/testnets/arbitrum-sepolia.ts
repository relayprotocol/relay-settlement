import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const arbitrumSepolia: NetworkConfig = {
  chainId: 421614n,
  contracts: {
    dev: {
      oracle: "0x53db93710C8d80ADa59db2b5ee63d7A4783fcD98",
    },
    prod: {
      oracle: "0x3b26D06Ea8252a73742d2125D1ACEb594ECEE5c6",
    },
  },
  family: "ethereum-vm",
  isTestnet: true,
  name: "Arbitrum Sepolia",
  rpc: process.env.RPC_421614
    ? [process.env.RPC_421614]
    : ["https://sepolia-rollup.arbitrum.io/rpc"],
  slug: "arbitrum-sepolia",
}
