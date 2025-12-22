import { NetworkConfig } from "@relay-settlement/types"

export const lisk: NetworkConfig = {
  chainId: 1135n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1135",
  isTestnet: false,
  name: "Lisk",
  rpc: process.env.RPC_1135
    ? [process.env.RPC_1135]
    : ["https://rpc.api.lisk.com"],
  slug: "lisk",
}
