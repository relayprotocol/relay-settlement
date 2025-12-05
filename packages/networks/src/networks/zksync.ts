import { NetworkConfig } from "@relay-protocol/types"

export const zksync: NetworkConfig = {
  chainId: 324n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "324",
  isTestnet: false,
  name: "zkSync",
  relaySolverChainId: 324,
  rpc: process.env.RPC_324
    ? [process.env.RPC_324]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "zksync",
}
