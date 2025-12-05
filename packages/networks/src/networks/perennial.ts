import { NetworkConfig } from "@relay-protocol/types"

export const perennial: NetworkConfig = {
  chainId: 1424n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1424",
  isTestnet: false,
  name: "Perennial",
  relaySolverChainId: 1424,
  rpc: process.env.RPC_1424
    ? [process.env.RPC_1424]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "perennial",
}
