import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const avalanche: NetworkConfig = {
  chainId: 43114n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "43114",
  isTestnet: false,
  name: "Avalanche",
  rpc: process.env.RPC_43114
    ? [process.env.RPC_43114]
    : [
        "https://api.avax.network/ext/bc/C/rpc",
        "https://rpc.ankr.com/avalanche",
      ],
  slug: "avalanche",
}
