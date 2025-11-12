import { NetworkConfig } from "@relay-protocol/types"

export const worldchain: NetworkConfig = {
  chainId: 480n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "480",
  isTestnet: false,
  name: "Worldchain",
  rpc: process.env.RPC_480
    ? [process.env.RPC_480]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "worldchain",
}
