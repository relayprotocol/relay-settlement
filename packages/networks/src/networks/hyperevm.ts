import { NetworkConfig } from "@relay-settlement/types"

export const hyperevm: NetworkConfig = {
  chainId: 999n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "999",
  isTestnet: false,
  name: "HyperEVM",
  rpc: process.env.RPC_999
    ? [process.env.RPC_999]
    : ["https://rpc.hyperliquid.xyz/evm"],
  slug: "hyperevm",
}
