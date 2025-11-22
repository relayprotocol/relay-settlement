import { NetworkConfig } from "@relay-protocol/types"

export const sovereignTestnet: NetworkConfig = {
  chainId: 6669n,
  contracts: {
    dev: {
      oracle: "0x9cd34B752C5e6482d37F5EE92B110cC85bD71547",
    },
    prod: {
      oracle: "0x9cd34B752C5e6482d37F5EE92B110cC85bD71547",
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
