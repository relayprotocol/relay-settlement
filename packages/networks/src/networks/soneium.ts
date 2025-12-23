import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const soneium: NetworkConfig = {
  chainId: 1868n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1868",
  isTestnet: false,
  name: "Soneium",
  rpc: process.env.RPC_1868
    ? [process.env.RPC_1868]
    : ["https://rpc.soneium.org"],
  slug: "soneium",
}
