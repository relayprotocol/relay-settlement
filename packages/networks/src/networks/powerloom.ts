import { NetworkConfig } from "@relay-protocol/types"

export const powerloom: NetworkConfig = {
  chainId: 7869n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "7869",
  isTestnet: false,
  name: "Powerloom",
  rpc: process.env.RPC_7869
    ? [process.env.RPC_7869]
    : ["https://rpc-v2.powerloom.network"],
  slug: "powerloom",
}
