import { NetworkConfig } from "@relay-settlement/types"

export const funki: NetworkConfig = {
  chainId: 33979n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "33979",
  isTestnet: false,
  name: "Funki",
  rpc: process.env.RPC_33979
    ? [process.env.RPC_33979]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "funki",
}
