import { NetworkConfig } from "@relay-settlement/types"

export const aurora: NetworkConfig = {
  assets: {
    wNEAR: "0xC42C30aC6Cc15faC9bD938618BcaA1a1FaE8501d",
  },
  blockExplorer: {
    chainId: 1313161554,
    network: "aurora",
    urls: {
      apiURL: "https://explorer.aurora.dev/api",
      browserURL: "https://explorer.aurora.dev",
    },
  },
  chainId: 1313161554n,
  contracts: {
    dev: {
      allocator: "0xFA2347546aeA769073643b32A10Fb4f3297B3d59",
    },
    prod: {
      allocator: "0xE12Bc514e90E136CAD10413669a6CcDeb9E3aDB7",
      multisigSigner: "0xb538ee6515F9d16eBD0BACD0503733815c9b070c",
    },
  },
  family: "ethereum-vm",
  isTestnet: false,
  name: "Aurora Mainnet (Near)",
  near: {
    rpc: "https://rpc.mainnet.near.org",
    signer: "v1.signer",
  },
  rpc: process.env.RPC_1313161554
    ? [process.env.RPC_1313161554]
    : ["https://mainnet.aurora.dev"],
  slug: "aurora",
}
