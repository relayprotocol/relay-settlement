import { NetworkConfig } from "@relay-protocol/types"

export const mantle: NetworkConfig = {
  chainId: 5000n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
  },
  family: "ethereum-vm",
  hubChainId: "5000",
  isTestnet: false,
  name: "Mantle",
  relaySolverChainId: 5000,
  rpc: process.env.RPC_5000
    ? [process.env.RPC_5000]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "mantle",
}
