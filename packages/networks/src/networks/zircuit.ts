import { NetworkConfig } from "@relay-settlement/types"

export const zircuit: NetworkConfig = {
  chainId: 48900n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "48900",
  isTestnet: false,
  name: "Zircuit",
  rpc: process.env.RPC_48900
    ? [process.env.RPC_48900]
    : ["https://zircuit1-mainnet.p2pify.com"],
  slug: "zircuit",
}
