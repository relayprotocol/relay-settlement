import { NetworkConfig } from "@relay-protocol/types"

export const boss: NetworkConfig = {
  chainId: 70701n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "70701",
  isTestnet: false,
  name: "Boss",
  rpc: process.env.RPC_70701
    ? [process.env.RPC_70701]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "boss",
}
