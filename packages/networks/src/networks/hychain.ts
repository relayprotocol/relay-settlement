import { NetworkConfig } from "@relay-settlement/types"

export const hychain: NetworkConfig = {
  chainId: 2911n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
  },
  family: "ethereum-vm",
  hubChainId: "2911",
  isTestnet: false,
  name: "Hychain",
  rpc: process.env.RPC_2911
    ? [process.env.RPC_2911]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "hychain",
}
