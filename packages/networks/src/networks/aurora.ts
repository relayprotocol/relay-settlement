import type { NetworkConfig } from "@relay-protocol/settlement-sdk"

export const aurora: NetworkConfig = {
  assets: {
    wNEAR: "0xC42C30aC6Cc15faC9bD938618BcaA1a1FaE8501d",
  },
  blockExplorer: {
    apiKey: "abc",
    chainId: 1313161554,
    network: "aurora",
    urls: {
      apiURL: "https://explorer.aurora.dev/api",
      browserURL: "https://explorer.aurora.dev",
    }, // Blockscout doesn't require a real API key
  },
  chainId: 1313161554n,
  contracts: {
    dev: {
      multisigSigner: "0xAFA58BbC787DcDa022B698dF78d613EA760727e2",
    },
    prod: {
      multisigSigner: "0xb538ee6515F9d16eBD0BACD0503733815c9b070c",
    },
    stag: {
      multisigSigner: "0x15334fe6F1cb0e286E1F9e1268B44E4221E169B7",
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
