import { NetworkConfig } from "@relay-settlement/types"

export const sonic: NetworkConfig = {
  chainId: 146n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "146",
  isTestnet: false,
  name: "Sonic",
  rpc: process.env.RPC_146
    ? [process.env.RPC_146]
    : ["https://rpc.soniclabs.com"],
  slug: "sonic",
}
