import { NetworkConfig } from "@relay-protocol/types"

export const solana: NetworkConfig = {
  chainId:
    50176979118388105370421134508366610418687875236156196470082648173271157915018n,
  contracts: {
    prod: { depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  },
  family: "solana-vm",
  hubChainId:
    "50176979118388105370421134508366610418687875236156196470082648173271157915018",
  isTestnet: false,
  name: "Solana",
  relaySolverChainId: 792703809,
  rpc: process.env.RPC_SOLANA
    ? [process.env.RPC_SOLANA]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "solana",
}
