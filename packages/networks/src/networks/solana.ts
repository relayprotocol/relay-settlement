import { NetworkConfig } from "@relay-settlement/types"

export const solana: NetworkConfig = {
  chainId:
    50176979118388105370421134508366610418687875236156196470082648173271157915018n,
  contracts: {
    dev: { depository: "6TMx4zgh9Ho5DaJtaQbKbHgYLk7B6vKEoE7CfnxkqcHv" },
    prod: { depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  },
  family: "solana-vm",
  hubChainId:
    "50176979118388105370421134508366610418687875236156196470082648173271157915018",
  isTestnet: false,
  name: "Solana",
  rpc: process.env.RPC_SOLANA
    ? [process.env.RPC_SOLANA]
    : ["https://api.mainnet-beta.solana.com"],
  slug: "solana",
}
