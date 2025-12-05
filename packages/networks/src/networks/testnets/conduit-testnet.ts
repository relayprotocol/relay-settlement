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
  contracts: {
    dev: {
      oracle: "0x64A3328Cf61025720c26dE2a87B6d913fA6e376a",
    },
    prod: {
      oracle: "0x64A3328Cf61025720c26dE2a87B6d913fA6e376a",
    },
  },
  family: "ethereum-vm",
  isTestnet: true,
  name: "Conduit Relay Settlement testnet",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  relaySolverChainId: 35779,
  rpc: process.env.RPC_35779
    ? [process.env.RPC_35779]
    : ["https://rpc-relay-settlement-testnet-7ht8qhd7mf.t.conduit.xyz"],
  slug: "conduit-testnet",
}
