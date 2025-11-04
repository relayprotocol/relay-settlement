import { NetworkConfig } from "@relay-protocol/types"

export const conduitTestnet: NetworkConfig = {
  blockExplorer: {
    chainId: 35779,
    network: "conduit-testnet",
    urls: {
      apiURL:
        "https://explorer-relay-settlement-testnet-7ht8qhd7mf.t.conduit.xyz/api",
      browserURL:
        "https://explorer-relay-settlement-testnet-7ht8qhd7mf.t.conduit.xyz",
    },
  },
  chainId: 35779n,
  family: "ethereum-vm",
  isTestnet: true,
  name: "Conduit Relay Settlement testnet",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  rpc: process.env.RPC_1313161555
    ? [process.env.RPC_1313161555]
    : ["https://rpc-relay-settlement-testnet-7ht8qhd7mf.t.conduit.xyz"],
  slug: "conduit-testnet",
}
