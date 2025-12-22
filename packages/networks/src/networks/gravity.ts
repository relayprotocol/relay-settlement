import { NetworkConfig } from "@relay-settlement/types"

export const gravity: NetworkConfig = {
  chainId: 1625n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1625",
  isTestnet: false,
  name: "Gravity",
  rpc: process.env.RPC_1625
    ? [process.env.RPC_1625]
    : ["https://rpc.gravity.xyz"],
  slug: "gravity",
}
