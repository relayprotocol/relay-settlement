import { NetworkConfig } from "@relay-settlement/types"

export const katana: NetworkConfig = {
  chainId: 747474n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "747474",
  isTestnet: false,
  name: "Katana",
  rpc: process.env.RPC_747474
    ? [process.env.RPC_747474]
    : ["https://rpc.katana.network"],
  slug: "katana",
}
