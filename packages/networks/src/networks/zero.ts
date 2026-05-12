import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const zero: NetworkConfig = {
  chainId: 543210n,
  contracts: {
    prod: { depository: "0xa88Cf7864951147a08707eD732237EAa9B1C3b9B" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "543210",
  isTestnet: false,
  name: "Zero",
  rpc: process.env.RPC_543210
    ? [process.env.RPC_543210]
    : ["https://rpc.zerion.io/v1/zero"],
  slug: "zero",
}
