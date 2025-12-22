import { NetworkConfig } from "@relay-settlement/types"

export const zksync: NetworkConfig = {
  chainId: 324n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "324",
  isTestnet: false,
  name: "zkSync",
  rpc: process.env.RPC_324
    ? [process.env.RPC_324]
    : ["https://mainnet.era.zksync.io"],
  slug: "zksync",
}
