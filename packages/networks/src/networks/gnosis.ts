import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const gnosis: NetworkConfig = {
  chainId: 100n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "100",
  isTestnet: false,
  name: "Gnosis",
  rpc: process.env.RPC_100
    ? [process.env.RPC_100]
    : ["https://rpc.gnosischain.com", "https://rpc.ankr.com/gnosis"],
  slug: "gnosis",
}
