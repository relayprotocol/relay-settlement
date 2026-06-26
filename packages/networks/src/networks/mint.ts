import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const mint: NetworkConfig = {
  chainId: 185n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "185",
  isTestnet: false,
  name: "Mint",
  rpc: process.env.RPC_185
    ? [process.env.RPC_185]
    : ["https://rpc.mintchain.io"],
  slug: "mint",
}
