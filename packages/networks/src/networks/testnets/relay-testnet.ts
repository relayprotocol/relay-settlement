import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const relayTestnet: NetworkConfig = {
  chainId: 537724n,
  contracts: {
    prod: {
      oracle: "",
    },
  },
  family: "ethereum-vm",
  isTestnet: true,
  name: "Relay testnet",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  rpc: process.env.RPC_537724
    ? [process.env.RPC_537724]
    : ["https://relay-devnet.sovereign-labs.xyz"],
  slug: "relay-testnet",
}
