import { NetworkConfig } from "@relay-settlement/types"

export const ethereal: NetworkConfig = {
  chainId: 5064014n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "5064014",
  isTestnet: false,
  name: "Ethereal",
  rpc: process.env.RPC_5064014
    ? [process.env.RPC_5064014]
    : ["https://rpc-ethereal-mainnet-0.t.conduit.xyz"],
  slug: "ethereal",
}
