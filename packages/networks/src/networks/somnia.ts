import { NetworkConfig } from "@relay-protocol/types"

export const somnia: NetworkConfig = {
  chainId: 5031n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "5031",
  isTestnet: false,
  name: "Somnia",
  relaySolverChainId: 5031,
  rpc: process.env.RPC_5031
    ? [process.env.RPC_5031]
    : ["https://api.infra.mainnet.somnia.network"],
  slug: "somnia",
}
