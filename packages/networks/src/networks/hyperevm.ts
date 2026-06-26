import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const hyperevm: NetworkConfig = {
  chainId: 999n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
    stag: { depository: "0xa4DA4Ec0558404CebBA46Bd112663723BC89829B" },
  },
  family: "ethereum-vm",
  hubChainId: "999",
  isTestnet: false,
  name: "HyperEVM",
  rpc: process.env.RPC_999
    ? [process.env.RPC_999]
    : ["https://rpc.hyperliquid.xyz/evm"],
  slug: "hyperevm",
}
