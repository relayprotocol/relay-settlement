import { NetworkConfig } from "@relay-protocol/types"

export const lordchain: NetworkConfig = {
  chainId: 84530008n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "84530008",
  isTestnet: false,
  name: "Lordchain",
  rpc: process.env.RPC_84530008
    ? [process.env.RPC_84530008]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "lordchain",
}
