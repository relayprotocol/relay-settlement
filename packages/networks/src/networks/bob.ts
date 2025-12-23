import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const bob: NetworkConfig = {
  chainId: 60808n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "60808",
  isTestnet: false,
  name: "BOB",
  rpc: process.env.RPC_60808
    ? [process.env.RPC_60808]
    : ["https://rpc.gobob.xyz"],
  slug: "bob",
}
