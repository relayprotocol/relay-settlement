import { NetworkConfig } from "@relay-protocol/types"

export const corn: NetworkConfig = {
  chainId: 21000000n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "21000000",
  isTestnet: false,
  name: "Corn",
  rpc: process.env.RPC_21000000
    ? [process.env.RPC_21000000]
    : ["[REDACTED-INTERNAL-RPC]"],
  slug: "corn",
}
