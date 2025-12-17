import { NetworkConfig } from "@relay-settlement/types"

export const megaeth: NetworkConfig = {
  chainId: 4326n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "4326",
  isTestnet: false,
  name: "MegaETH",
  rpc: process.env.RPC_4326
    ? [process.env.RPC_4326]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "megaeth",
}
