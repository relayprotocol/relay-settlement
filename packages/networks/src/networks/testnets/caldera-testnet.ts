import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const calderaTestnet: NetworkConfig = {
  blockExplorer: {
    chainId: 5377137,
    network: "caldera-testnet",
    urls: {
      apiURL: "https://relay-settlement-testnet.explorer.caldera.xyz/api",
      browserURL: "https://relay-settlement-testnet.explorer.caldera.xyz/",
    },
  },
  chainId: 5377137n,
  contracts: {
    dev: {
      oracle: "0x259813B665C8f6074391028ef782e27B65840d89",
    },
    prod: {
      oracle: "0x259813B665C8f6074391028ef782e27B65840d89",
    },
  },
  family: "ethereum-vm",
  isTestnet: true,
  name: "Caldera Relay Settlement testnet",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  rpc: process.env.RPC_5377137
    ? [process.env.RPC_5377137]
    : ["https://relay-settlement-testnet.rpc.caldera.xyz/http"],
  slug: "caldera-testnet",
}
