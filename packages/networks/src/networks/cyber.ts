import { NetworkConfig } from "@relay-protocol/types"

export const cyber: NetworkConfig = {
  chainId: 7560n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "7560",
  isTestnet: false,
  name: "Cyber",
  rpc: process.env.RPC_7560
    ? [process.env.RPC_7560]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "cyber",
}
