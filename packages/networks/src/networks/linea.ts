import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const linea: NetworkConfig = {
  chainId: 59144n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
  },
  family: "ethereum-vm",
  hubChainId: "59144",
  isTestnet: false,
  name: "Linea",
  rpc: process.env.RPC_59144
    ? [process.env.RPC_59144]
    : ["https://rpc.linea.build", "https://linea.drpc.org"],
  slug: "linea",
}
