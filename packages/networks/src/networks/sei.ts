import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const sei: NetworkConfig = {
  chainId: 1329n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "1329",
  isTestnet: false,
  name: "Sei",
  rpc: process.env.RPC_1329
    ? [process.env.RPC_1329]
    : ["https://evm-rpc.sei-apis.com"],
  slug: "sei",
}
