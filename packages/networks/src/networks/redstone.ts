import { NetworkConfig } from "@relay-settlement/types"

export const redstone: NetworkConfig = {
  chainId: 690n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "690",
  isTestnet: false,
  name: "Redstone",
  rpc: process.env.RPC_690
    ? [process.env.RPC_690]
    : ["https://rpc.redstonechain.com"],
  slug: "redstone",
}
