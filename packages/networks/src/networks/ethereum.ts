import { NetworkConfig } from "@relay-protocol/types"

export const ethereum: NetworkConfig = {
  chainId: 1n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1",
  isTestnet: false,
  name: "Ethereum",
  rpc: process.env.RPC_1
    ? [process.env.RPC_1]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "ethereum",
}
