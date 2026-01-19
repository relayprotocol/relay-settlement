import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const relay: NetworkConfig = {
  blockExplorer: {
    apiKey: "",
    chainId: 1313161554,
    network: "relay",
    urls: {
      apiURL: "https://explorer.chain.relay.link/api",
      browserURL: "https://explorer.chain.relay.link",
    },
  },
  chainId: 537713n,
  contracts: {
    dev: {
      oracle: "",
    },
    prod: {
      oracle: "",
    },
  },
  family: "ethereum-vm",
  isTestnet: true,
  name: "Relay Chain",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  rpc: process.env.RPC_RELAY_CHAIN
    ? [process.env.RPC_RELAY_CHAIN]
    : ["https://rpc.chain.relay.link"],
  slug: "relay",
}
