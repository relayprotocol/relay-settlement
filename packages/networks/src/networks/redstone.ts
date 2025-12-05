import { NetworkConfig } from "@relay-protocol/types"

export const redstone: NetworkConfig = {
  chainId: 690n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "690",
  isTestnet: false,
  name: "Redstone",
  relaySolverChainId: 690,
  rpc: process.env.RPC_690
    ? [process.env.RPC_690]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "redstone",
}
