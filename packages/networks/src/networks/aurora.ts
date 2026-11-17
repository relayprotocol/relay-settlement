import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

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
    // Owned by the deployers Safe; derives EVM sender 0x463c…F56E.
    deployers: {
      multisigSigner: "0xE5Ee6a6E8D57d1D315D1898c68eA1bc487B6EA92",
    },
    dev: {
      multisigSigner: "0xAFA58BbC787DcDa022B698dF78d613EA760727e2",
    },
    prod: {
      multisigSigner: "0xb538ee6515F9d16eBD0BACD0503733815c9b070c",
    },
    stag: {
      multisigSigner: "0x15334fe6F1cb0e286E1F9e1268B44E4221E169B7",
    },
    // Test env (Arbitrum Sepolia Hub); owned by the dev/stag Safe, derives
    // EVM sender 0xBB91…51EB.
    test: {
      multisigSigner: "0x192d296616b699E27cD9Cb7142d1ab77Fe41eE3A",
    },
  },
  family: "ethereum-vm",
  isTestnet: false,
  name: "Aurora Mainnet (Near)",
  near: {
    rpc: "https://rpc.mainnet.near.org",
    signer: "v1.signer",
  },
  ...resolveRpc(process.env.RPC_1313161554, ["https://mainnet.aurora.dev"]),
  slug: "aurora",
}
