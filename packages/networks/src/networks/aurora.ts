import { NetworkConfig } from "@relay-protocol/types"

export const aurora: NetworkConfig = {
  assets: {
    wNEAR: "0xC42C30aC6Cc15faC9bD938618BcaA1a1FaE8501d",
  },
  chainId: 1313161554n,
  contracts: {
    dev: {
      allocator: "0xFA2347546aeA769073643b32A10Fb4f3297B3d59",
    },
    prod: {
      allocator: "0xE12Bc514e90E136CAD10413669a6CcDeb9E3aDB7",
      multisigSigner: "0x66667945C34b399993cA834587886b8508dB39B1",
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
