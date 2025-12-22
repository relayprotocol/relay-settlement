import { NetworkConfig } from "@relay-settlement/types"

export const arbitrum: NetworkConfig = {
  chainId: 42161n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "42161",
  isTestnet: false,
  name: "Arbitrum",
  rpc: process.env.RPC_42161
    ? [process.env.RPC_42161]
    : ["https://arb1.arbitrum.io/rpc", "https://rpc.ankr.com/arbitrum"],
  slug: "arbitrum",
}
