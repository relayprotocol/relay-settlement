import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const ink: NetworkConfig = {
  chainId: 57073n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "57073",
  isTestnet: false,
  name: "Ink",
  rpc: process.env.RPC_57073
    ? [process.env.RPC_57073]
    : ["https://rpc-gel.inkonchain.com"],
  slug: "ink",
}
