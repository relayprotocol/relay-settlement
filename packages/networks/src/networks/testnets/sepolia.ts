import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const sepolia: NetworkConfig = {
  chainId: 11155111n,
  contracts: {
    prod: {
      depository: "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3",
    },
  },
  family: "ethereum-vm",
  hubChainId: "11155111",
  isTestnet: true,
  name: "Sepolia",
  rpc: process.env.RPC_11155111
    ? [process.env.RPC_11155111]
    : ["https://ethereum-sepolia-rpc.publicnode.com"],
  slug: "sepolia",
}
