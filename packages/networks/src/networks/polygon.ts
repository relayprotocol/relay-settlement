import { NetworkConfig } from "@relay-protocol/types"

export const polygon: NetworkConfig = {
  chainId: 137n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "137",
  isTestnet: false,
  name: "Polygon",
  rpc: process.env.RPC_137
    ? [process.env.RPC_137]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "polygon",
}
