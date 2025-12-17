import { NetworkConfig } from "@relay-protocol/types"

export const sovereignTestnet: NetworkConfig = {
  chainId: 6669n,
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
  name: "Sovereign testnet",
  nativeCurrency: {
    decimals: 18,
    name: "eth",
    symbol: "eth",
  },
  rpc: process.env.RPC_6669
    ? [process.env.RPC_6669]
    : ["http://23.22.122.118/rpc"],
  slug: "sovereign-testnet",
}
