import { NetworkConfig } from "@relay-protocol/types"

export const swellchain: NetworkConfig = {
  chainId: 1923n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "1923",
  isTestnet: false,
  name: "Swellchain",
  rpc: process.env.RPC_1923
    ? [process.env.RPC_1923]
    : ["https://swell-mainnet.alt.technology"],
  slug: "swellchain",
}
