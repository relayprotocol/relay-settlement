import { NetworkConfig } from "@relay-protocol/types"

export const degen: NetworkConfig = {
  chainId: 666666666n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "666666666",
  isTestnet: false,
  name: "Degen",
  rpc: process.env.RPC_666666666
    ? [process.env.RPC_666666666]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "degen",
}
