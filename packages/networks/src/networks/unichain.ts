import { NetworkConfig } from "@relay-settlement/types"

export const unichain: NetworkConfig = {
  chainId: 130n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "130",
  isTestnet: false,
  name: "Unichain",
  rpc: process.env.RPC_130
    ? [process.env.RPC_130]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "unichain",
}
