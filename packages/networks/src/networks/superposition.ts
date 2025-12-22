import { NetworkConfig } from "@relay-settlement/types"

export const superposition: NetworkConfig = {
  chainId: 55244n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "55244",
  isTestnet: false,
  name: "Superposition",
  rpc: process.env.RPC_55244
    ? [process.env.RPC_55244]
    : ["https://rpc.superposition.so"],
  slug: "superposition",
}
