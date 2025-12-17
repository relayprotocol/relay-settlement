import { NetworkConfig } from "@relay-settlement/types"

export const boba: NetworkConfig = {
  chainId: 288n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "288",
  isTestnet: false,
  name: "Boba",
  rpc: process.env.RPC_288
    ? [process.env.RPC_288]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "boba",
}
