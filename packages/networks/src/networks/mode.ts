import { NetworkConfig } from "@relay-settlement/types"

export const mode: NetworkConfig = {
  chainId: 34443n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "34443",
  isTestnet: false,
  name: "Mode",
  rpc: process.env.RPC_34443
    ? [process.env.RPC_34443]
    : ["https://mainnet.mode.network"],
  slug: "mode",
}
