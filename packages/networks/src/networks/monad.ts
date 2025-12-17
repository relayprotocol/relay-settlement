import { NetworkConfig } from "@relay-protocol/types"

export const monad: NetworkConfig = {
  chainId: 143n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "143",
  isTestnet: false,
  name: "Monad",
  rpc: process.env.RPC_143
    ? [process.env.RPC_143]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "monad",
}
