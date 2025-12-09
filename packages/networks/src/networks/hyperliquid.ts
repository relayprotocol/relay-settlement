import { NetworkConfig } from "@relay-protocol/types"

export const hyperliquid: NetworkConfig = {
  chainId:
    111378472430415857054556056192544272316610524417112732947551032542507639335976n,
  contracts: {
    dev: { depository: "0x85594C5D28AC8bF20e6Ef0b9620F648F3737607F" },
    prod: { depository: "0x865eb9bAa5492cEf598ADf7AFb1038654fcB7081" },
  },
  family: "hyperliquid-vm",
  hubChainId:
    "111378472430415857054556056192544272316610524417112732947551032542507639335976",
  isTestnet: false,
  name: "Hyperliquid",
  relaySolverChainId: 1337,
  rpc: process.env.RPC_HYPERLIQUID
    ? [process.env.RPC_HYPERLIQUID]
    : ["https://api.hyperliquid.xyz"],
  slug: "hyperliquid",
}
