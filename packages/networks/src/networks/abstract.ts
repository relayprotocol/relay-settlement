import { NetworkConfig } from "@relay-protocol/types"

export const abstract: NetworkConfig = {
  chainId: 2741n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "2741",
  isTestnet: false,
  name: "Abstract",
  rpc: process.env.RPC_2741
    ? [process.env.RPC_2741]
    : ["https://api.mainnet.abs.xyz"],
  slug: "abstract",
}
