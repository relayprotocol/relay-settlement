import { NetworkConfig } from "@relay-settlement/types"

export const story: NetworkConfig = {
  chainId: 1514n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1514",
  isTestnet: false,
  name: "Story",
  rpc: process.env.RPC_1514
    ? [process.env.RPC_1514]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "story",
}
