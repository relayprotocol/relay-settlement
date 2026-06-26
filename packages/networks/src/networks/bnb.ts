import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const bnb: NetworkConfig = {
  chainId: 56n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
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
