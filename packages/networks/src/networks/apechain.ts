import { NetworkConfig } from "@relay-protocol/types"

export const apechain: NetworkConfig = {
  chainId: 33139n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "33139",
  isTestnet: false,
  name: "Apechain",
  relaySolverChainId: 33139,
  rpc: process.env.RPC_33139
    ? [process.env.RPC_33139]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "apechain",
}
