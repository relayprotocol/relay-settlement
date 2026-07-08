import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const arc: NetworkConfig = {
  chainId: 5042n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0x9ddC6a541e8F8B50B0996786A3eC275AB4d3A76C" },
  },
  family: "ethereum-vm",
  hubChainId: "5042",
  isTestnet: false,
  name: "Arc",
  rpc: [process.env.RPC_5042 ?? ""],
  slug: "arc",
}
