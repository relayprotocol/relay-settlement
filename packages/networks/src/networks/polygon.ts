import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const polygon: NetworkConfig = {
  chainId: 137n,
  contracts: {
    dev: { depository: "0x5CB1De3603A71Ac2f67b12bFbF095013FE4Ac299" },
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "137",
  isTestnet: false,
  name: "Polygon",
  rpc: process.env.RPC_137
    ? [process.env.RPC_137]
    : ["https://polygon-rpc.com", "https://rpc.ankr.com/polygon"],
  slug: "polygon",
}
