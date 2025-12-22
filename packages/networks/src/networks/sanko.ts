import { NetworkConfig } from "@relay-settlement/types"

export const sanko: NetworkConfig = {
  chainId: 1996n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1996",
  isTestnet: false,
  name: "Sanko",
  rpc: process.env.RPC_1996
    ? [process.env.RPC_1996]
    : ["https://mainnet.sanko.xyz"],
  slug: "sanko",
}
