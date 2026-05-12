import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const anime: NetworkConfig = {
  chainId: 69000n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "69000",
  isTestnet: false,
  name: "Anime",
  rpc: process.env.RPC_69000
    ? [process.env.RPC_69000]
    : ["https://rpc-animechain-39xf6m45e3.t.conduit.xyz"],
  slug: "anime",
}
