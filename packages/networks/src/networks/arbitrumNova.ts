import { NetworkConfig } from "@relay-settlement/types"

export const arbitrumNova: NetworkConfig = {
  chainId: 42170n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "42170",
  isTestnet: false,
  name: "Arbitrum Nova",
  rpc: process.env.RPC_42170
    ? [process.env.RPC_42170]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "arbitrum_nova",
}
