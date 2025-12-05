import { NetworkConfig } from "@relay-protocol/types"

export const bnb: NetworkConfig = {
  chainId: 56n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "56",
  isTestnet: false,
  name: "BNB Chain",
  relaySolverChainId: 56,
  rpc: process.env.RPC_56
    ? [process.env.RPC_56]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "bnb",
}
