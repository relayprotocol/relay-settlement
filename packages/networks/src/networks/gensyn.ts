import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const gensyn: NetworkConfig = {
  chainId: 685689n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "685689",
  isTestnet: false,
  name: "Gensyn",
  // RPC must be provided via RPC_685689 — no public default available.
  rpc: [process.env.RPC_685689 ?? ""],
  slug: "gensyn",
}
