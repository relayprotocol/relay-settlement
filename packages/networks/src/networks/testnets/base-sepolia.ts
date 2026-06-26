import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const baseSepolia: NetworkConfig = {
  chainId: 84532n,
  contracts: {
    prod: {
      depository: "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3",
    },
  },
  family: "ethereum-vm",
  hubChainId: "84532",
  isTestnet: true,
  name: "Base Sepolia",
  rpc: process.env.RPC_84532
    ? [process.env.RPC_84532]
    : ["https://sepolia.base.org"],
  slug: "base-sepolia",
}
