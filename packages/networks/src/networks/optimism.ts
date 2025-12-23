import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const optimism: NetworkConfig = {
  chainId: 10n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "10",
  isTestnet: false,
  name: "Optimism",
  rpc: process.env.RPC_10
    ? [process.env.RPC_10]
    : ["https://mainnet.optimism.io", "https://rpc.ankr.com/optimism"],
  slug: "optimism",
}
