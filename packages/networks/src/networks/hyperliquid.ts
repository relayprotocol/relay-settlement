import { NetworkConfig } from "@relay-protocol/types"

export const hyperliquid: NetworkConfig = {
  chainId:
    111378472430415857054556056192544272316610524417112732947551032542507639335976n,
  family: "hyperliquid-vm",
  hubChainId:
    "111378472430415857054556056192544272316610524417112732947551032542507639335976",
  isTestnet: false,
  name: "Hyperliquid",
  rpc: process.env.RPC_HYPERLIQUID
    ? [process.env.RPC_HYPERLIQUID]
    : ["https://api.hyperliquid.xyz"],
  slug: "hyperliquid",
}
