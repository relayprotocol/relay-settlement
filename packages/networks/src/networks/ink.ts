import { NetworkConfig } from "@relay-settlement/types"

export const ink: NetworkConfig = {
  chainId: 57073n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "57073",
  isTestnet: false,
  name: "Ink",
  rpc: process.env.RPC_57073
    ? [process.env.RPC_57073]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "ink",
}
