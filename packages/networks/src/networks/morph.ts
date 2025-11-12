import { NetworkConfig } from "@relay-protocol/types"

export const morph: NetworkConfig = {
  chainId: 2818n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "2818",
  isTestnet: false,
  name: "Morph",
  rpc: process.env.RPC_2818
    ? [process.env.RPC_2818]
    : ["https://rpc.morphl2.io"],
  slug: "morph",
}
