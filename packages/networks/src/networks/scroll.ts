import { NetworkConfig } from "@relay-settlement/types"

export const scroll: NetworkConfig = {
  chainId: 534352n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "534352",
  isTestnet: false,
  name: "Scroll",
  rpc: process.env.RPC_534352
    ? [process.env.RPC_534352]
    : ["https://rpc.scroll.io"],
  slug: "scroll",
}
