import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const relayTestnet: NetworkConfig = {
  chainId: 537724n,
  contracts: {
    prod: {
      hub: "0xf98D7ADA874D53a75BbDfB05D2A96C1525d426A7",
      oracle: "0x259813B665C8f6074391028ef782e27B65840d89",
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
    : ["https://rpc.testnet.relay.link"],
  slug: "relay-testnet",
}
