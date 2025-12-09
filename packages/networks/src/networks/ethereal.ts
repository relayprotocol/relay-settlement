import { NetworkConfig } from "@relay-protocol/types"

export const ethereal: NetworkConfig = {
  chainId: 5064014n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "5064014",
  isTestnet: false,
  name: "Ethereal",
  relaySolverChainId: 5064014,
  rpc: process.env.RPC_5064014
    ? [process.env.RPC_5064014]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "ethereal",
}
