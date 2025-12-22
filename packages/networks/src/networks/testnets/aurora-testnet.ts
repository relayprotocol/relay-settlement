import { NetworkConfig } from "@relay-settlement/types"

export const auroraTestnet: NetworkConfig = {
  assets: {
    wNEAR: "0x4861825E75ab14553E5aF711EbbE6873d369d146",
  },
  blockExplorer: {
    chainId: 1313161555,
    network: "aurora-testnet",
    urls: {
      apiURL: "https://explorer.testnet.aurora.dev/api",
      browserURL: "https://explorer.testnet.aurora.dev",
    },
  },
  chainId: 1313161555n,
  family: "ethereum-vm",
  isTestnet: true,
  name: "Aurora testnet",
  near: {
    rpc: "https://test.rpc.fastnear.com",
    signer: "v1.signer-prod.testnet",
  },
  rpc: process.env.RPC_1313161555
    ? [process.env.RPC_1313161555]
    : ["https://testnet.aurora.dev"],
  slug: "aurora-testnet",
}
