import { NetworkConfig } from "@relay-settlement/types"

export const bnb: NetworkConfig = {
  chainId: 56n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "56",
  isTestnet: false,
  name: "BNB Chain",
  rpc: process.env.RPC_56
    ? [process.env.RPC_56]
    : ["https://bsc-dataseed.binance.org", "https://rpc.ankr.com/bsc"],
  slug: "bnb",
}
