import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const relay: NetworkConfig = {
  blockExplorer: {
    apiKey: "",
    chainId: 537713,
    network: "relay",
    urls: {
      apiURL: "https://explorer.chain.relay.link/api",
      browserURL: "https://explorer.chain.relay.link",
    },
  },
  chainId: 537713n,
  contracts: {
    dev: {
      hub: "",
      oracle: "",
    },
    prod: {
      hub: "0xDDD361727C22A01EB137880678A20b0BEaE69318",
      oracle: "0xd4b9fdB83C723c096d7fBE72da252aa23f1387aa",
    },
  },
  earliestBlock: 1215200,
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
