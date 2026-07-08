import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const monad: NetworkConfig = {
  chainId: 143n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "143",
  isTestnet: false,
  name: "Monad",
  rpc: process.env.RPC_143
    ? [process.env.RPC_143]
    : ["https://rpc-mainnet.monadinfra.com", "https://rpc.monad.xyz"],
  slug: "monad",
}
