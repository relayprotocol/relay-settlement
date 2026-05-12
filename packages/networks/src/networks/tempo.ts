import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const tempo: NetworkConfig = {
  chainId: 4217n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "4217",
  isTestnet: false,
  name: "Tempo",
  rpc: process.env.RPC_4217
    ? [process.env.RPC_4217]
    : ["https://tempo-mainnet.drpc.org"],
  slug: "tempo",
}
