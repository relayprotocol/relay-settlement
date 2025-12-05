import { NetworkConfig } from "@relay-protocol/types"

export const ronin: NetworkConfig = {
  chainId: 2020n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "2020",
  isTestnet: false,
  name: "Ronin",
  relaySolverChainId: 2020,
  rpc: process.env.RPC_2020
    ? [process.env.RPC_2020]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "ronin",
}
