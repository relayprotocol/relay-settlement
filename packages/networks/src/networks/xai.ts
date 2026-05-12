import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const xai: NetworkConfig = {
  chainId: 660279n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "660279",
  isTestnet: false,
  name: "XAI",
  rpc: process.env.RPC_660279
    ? [process.env.RPC_660279]
    : ["https://xai-chain.net/rpc"],
  slug: "xai",
}
