import { NetworkConfig } from "@relay-protocol/types"

export const flow: NetworkConfig = {
  chainId: 747n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "747",
  isTestnet: false,
  name: "Flow",
  rpc: process.env.RPC_747
    ? [process.env.RPC_747]
    : ["https://mainnet.evm.nodes.onflow.org"],
  slug: "flow",
}
