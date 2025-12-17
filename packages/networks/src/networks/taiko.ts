import { NetworkConfig } from "@relay-settlement/types"

export const taiko: NetworkConfig = {
  chainId: 167000n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
  },
  family: "ethereum-vm",
  hubChainId: "167000",
  isTestnet: false,
  name: "Taiko",
  rpc: process.env.RPC_167000
    ? [process.env.RPC_167000]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "taiko",
}
