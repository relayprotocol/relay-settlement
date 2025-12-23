import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const hemi: NetworkConfig = {
  chainId: 43111n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "43111",
  isTestnet: false,
  name: "Hemi",
  rpc: process.env.RPC_43111
    ? [process.env.RPC_43111]
    : ["https://rpc.hemi.network/rpc"],
  slug: "hemi",
}
