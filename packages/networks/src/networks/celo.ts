import { NetworkConfig } from "@relay-protocol/types"

export const celo: NetworkConfig = {
  chainId: 42220n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "42220",
  isTestnet: false,
  name: "Celo",
  rpc: process.env.RPC_42220
    ? [process.env.RPC_42220]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "celo",
}
