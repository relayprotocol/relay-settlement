import { NetworkConfig } from "@relay-protocol/types"

export const b3: NetworkConfig = {
  chainId: 8333n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "8333",
  isTestnet: false,
  name: "B3",
  rpc: process.env.RPC_8333
    ? [process.env.RPC_8333]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "b3",
}
