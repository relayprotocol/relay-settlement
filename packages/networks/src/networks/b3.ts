import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const b3: NetworkConfig = {
  chainId: 8333n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "8333",
  isTestnet: false,
  name: "B3",
  rpc: process.env.RPC_8333
    ? [process.env.RPC_8333]
    : ["https://mainnet-rpc.b3.fun/http"],
  slug: "b3",
}
