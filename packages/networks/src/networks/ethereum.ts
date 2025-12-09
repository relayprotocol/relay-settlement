import { NetworkConfig } from "@relay-protocol/types"

export const ethereum: NetworkConfig = {
  chainId: 1n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1",
  isTestnet: false,
  name: "Ethereum",
  relaySolverChainId: 1,
  rpc: process.env.RPC_1
    ? [process.env.RPC_1]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "ethereum",
}
