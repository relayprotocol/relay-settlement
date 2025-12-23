import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const syndicate: NetworkConfig = {
  chainId: 510003n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "510003",
  isTestnet: false,
  name: "Syndicate",
  rpc: process.env.RPC_510003
    ? [process.env.RPC_510003]
    : ["https://commons.rpc.syndicate.io"],
  slug: "syndicate",
}
