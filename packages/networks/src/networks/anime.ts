import { NetworkConfig } from "@relay-protocol/types"

export const anime: NetworkConfig = {
  chainId: 69000n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "69000",
  isTestnet: false,
  name: "Anime",
  relaySolverChainId: 69000,
  rpc: process.env.RPC_69000
    ? [process.env.RPC_69000]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "anime",
}
