import { NetworkConfig } from "@relay-protocol/types"

export const tron: NetworkConfig = {
  chainId: 728126428n,
  contracts: {
    prod: { depository: "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN" },
  },
  family: "tron-vm",
  hubChainId: "728126428",
  isTestnet: false,
  name: "Tron",
  relaySolverChainId: 728126428,
  rpc: process.env.RPC_TRON
    ? [process.env.RPC_TRON]
    : ["https://api.trongrid.io/jsonrpc"],
  slug: "tron",
}
