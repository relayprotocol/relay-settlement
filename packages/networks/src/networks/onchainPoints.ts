import { NetworkConfig } from "@relay-protocol/types"

export const onchainPoints: NetworkConfig = {
  chainId: 17071n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "17071",
  isTestnet: false,
  name: "Onchain Points",
  rpc: process.env.RPC_17071
    ? [process.env.RPC_17071]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "onchain_points",
}
