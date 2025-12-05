import { NetworkConfig } from "@relay-protocol/types"

export const berachain: NetworkConfig = {
  chainId: 80094n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "80094",
  isTestnet: false,
  name: "Berachain",
  relaySolverChainId: 80094,
  rpc: process.env.RPC_80094
    ? [process.env.RPC_80094]
    : ["https://rpc.berachain.com"],
  slug: "berachain",
}
