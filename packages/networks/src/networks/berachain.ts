import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const berachain: NetworkConfig = {
  chainId: 80094n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "80094",
  isTestnet: false,
  name: "Berachain",
  rpc: process.env.RPC_80094
    ? [process.env.RPC_80094]
    : ["https://rpc.berachain.com"],
  slug: "berachain",
}
