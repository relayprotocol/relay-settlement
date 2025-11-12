import { NetworkConfig } from "@relay-protocol/types"

export const arbitrumSepolia: NetworkConfig = {
  chainId: 421614n,
  contracts: {
    dev: {
      oracle: "0x64A3328Cf61025720c26dE2a87B6d913fA6e376a",
    },
    prod: {
      oracle: "0x53db93710C8d80ADa59db2b5ee63d7A4783fcD98",
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
