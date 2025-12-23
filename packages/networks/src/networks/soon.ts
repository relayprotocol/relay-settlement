import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const soon: NetworkConfig = {
  chainId:
    47666768346798787887243539464098327979042864045901211358526436336861836132973n,
  contracts: {
    prod: { depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  },
  family: "solana-vm",
  hubChainId:
    "47666768346798787887243539464098327979042864045901211358526436336861836132973",
  isTestnet: false,
  name: "Soon",
  rpc: process.env.RPC_SOON
    ? [process.env.RPC_SOON]
    : ["https://rpc.mainnet.soo.network/rpc"],
  slug: "soon",
}
