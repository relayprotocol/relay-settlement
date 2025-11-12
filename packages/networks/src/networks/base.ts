import { NetworkConfig } from "@relay-protocol/types"

export const base: NetworkConfig = {
  chainId: 8453n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "8453",
  isTestnet: false,
  name: "Base",
  rpc: process.env.RPC_8453
    ? [process.env.RPC_8453]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "base",
}
