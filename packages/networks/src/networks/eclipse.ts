import { NetworkConfig } from "@relay-protocol/types"

export const eclipse: NetworkConfig = {
  chainId:
    64090895945001603038992093854505754448788867346671798212401362354189266349171n,
  contracts: {
    prod: { depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  },
  family: "solana-vm",
  hubChainId:
    "64090895945001603038992093854505754448788867346671798212401362354189266349171",
  isTestnet: false,
  name: "Eclipse",
  rpc: process.env.RPC_ECLIPSE
    ? [process.env.RPC_ECLIPSE]
    : [
        "[REDACTED-INTERNAL-RPC]",
      ],
  slug: "eclipse",
}
