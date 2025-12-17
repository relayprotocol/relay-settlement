import { NetworkConfig } from "@relay-protocol/types"

export const polygonZkevm: NetworkConfig = {
  chainId: 1101n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
  },
  family: "ethereum-vm",
  hubChainId: "1101",
  isTestnet: false,
  name: "Polygon zkEVM",
  rpc: process.env.RPC_1101
    ? [process.env.RPC_1101]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "polygon_zkevm",
}
