import { NetworkConfig } from "@relay-settlement/types"

export const mythos: NetworkConfig = {
  chainId: 201804n,
  family: "ethereum-vm",
  hubChainId: "201804",
  isTestnet: false,
  name: "Mythos",
  rpc: process.env.RPC_201804
    ? [process.env.RPC_201804]
    : ["https://chain-rpc.mythicalgames.com"],
  slug: "mythos",
}
