import { NetworkConfig } from "@relay-protocol/types"

export const sei: NetworkConfig = {
  chainId: 1329n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1329",
  isTestnet: false,
  name: "Sei",
  rpc: process.env.RPC_1329
    ? [process.env.RPC_1329]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "sei",
}
