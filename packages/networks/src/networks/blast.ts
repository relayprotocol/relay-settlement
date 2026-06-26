import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const blast: NetworkConfig = {
  chainId: 81457n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "81457",
  isTestnet: false,
  name: "Blast",
  rpc: process.env.RPC_81457
    ? [process.env.RPC_81457]
    : ["https://rpc.blast.io", "https://rpc.ankr.com/blast"],
  slug: "blast",
}
