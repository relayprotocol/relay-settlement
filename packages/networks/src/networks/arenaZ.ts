import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const arenaZ: NetworkConfig = {
  chainId: 7897n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "7897",
  isTestnet: false,
  name: "Arena Z",
  rpc: process.env.RPC_7897
    ? [process.env.RPC_7897]
    : ["https://rpc.arena-z.gg"],
  slug: "arena_z",
}
