// ABOUTME: Derives the underlying MPC wallet address controlled by a RelayMultisigSigner contract
// ABOUTME: for a given VM type/family, via NEAR chain-signatures.

import { Command } from "commander"
import { networks } from "@relay-protocol/settlement-networks"
import type { VmType } from "@relay-protocol/settlement-sdk"
import { createPublicClient, http } from "viem"
import { deriveAllocatorSignerAddress } from "../src/crypto/signer"

// The RelayMultisigSigner contract is deployed on Aurora.
const AURORA_CHAIN_ID = 1313161554n

type NetworkConfig = {
  slug: string
  chainId: bigint
  family: VmType
  isTestnet?: boolean
  rpc: string[]
  contracts?: Record<string, { multisigSigner?: string }>
}

const VM_FAMILIES: VmType[] = [
  "ethereum-vm",
  "solana-vm",
  "bitcoin-vm",
  "tron-vm",
  "hyperliquid-vm",
]

// VM families that derive to an EVM-style address.
const toDerivationFamily = (family: VmType): VmType =>
  family === "hyperliquid-vm" ? "ethereum-vm" : family

async function main() {
  const program = new Command()
  program
    .name("derive-signer-address")
    .description(
      "Derive the MPC wallet address controlled by a RelayMultisigSigner contract for a VM family"
    )
    .requiredOption(
      "-f, --family <vmType>",
      `VM type/family to derive the signer address for (${VM_FAMILIES.join(" | ")})`
    )
    .option(
      "-m, --multisig-signer <address>",
      "RelayMultisigSigner contract address (defaults to Aurora's deployment for the given env)"
    )
    .option(
      "-e, --env <env>",
      "Deployment environment to read the multisig signer from (prod | dev | stag)",
      "prod"
    )
    .option(
      "--bitcoin-network <name>",
      "Bitcoin network name to use for bitcoin-vm derivation (e.g. bitcoin | testnet)",
      "bitcoin"
    )
    .option(
      "--aurora-rpc <url>",
      "Override the Aurora RPC URL used to query the contract"
    )
    .parse(process.argv)

  const opts = program.opts<{
    family: string
    multisigSigner?: string
    env: string
    bitcoinNetwork: string
    auroraRpc?: string
  }>()

  const family = opts.family as VmType
  if (!VM_FAMILIES.includes(family)) {
    throw new Error(
      `Unknown VM family "${opts.family}". Expected one of: ${VM_FAMILIES.join(", ")}.`
    )
  }

  const aurora = (networks as Record<string, NetworkConfig>)[
    String(AURORA_CHAIN_ID)
  ]
  if (!aurora) {
    throw new Error("Aurora network config not found")
  }

  const multisigSigner =
    opts.multisigSigner ?? aurora.contracts?.[opts.env]?.multisigSigner
  if (!multisigSigner) {
    throw new Error(
      `No multisigSigner address found for Aurora env "${opts.env}". Pass --multisig-signer.`
    )
  }

  const auroraRpc = opts.auroraRpc ?? aurora.rpc[0]
  const auroraClient = createPublicClient({
    chain: {
      id: Number(AURORA_CHAIN_ID),
      name: "Aurora",
      nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
      rpcUrls: {
        default: { http: [auroraRpc] },
        public: { http: [auroraRpc] },
      },
    },
    transport: http(auroraRpc),
  })

  const derivationFamily = toDerivationFamily(family)

  console.log("\n🔑 Deriving MPC wallet address")
  console.log(`  Multisig signer: ${multisigSigner} (Aurora)`)
  console.log(`  VM family:       ${family}`)
  if (derivationFamily === "bitcoin-vm") {
    console.log(`  Bitcoin network: ${opts.bitcoinNetwork}`)
  }
  console.log("")

  const signerAddress = await deriveAllocatorSignerAddress(
    auroraClient,
    multisigSigner,
    derivationFamily,
    opts.bitcoinNetwork
  )

  if (!signerAddress) {
    throw new Error(
      `Failed to derive signer address for VM family "${family}".`
    )
  }

  console.log(`✅ Derived address: ${signerAddress}\n`)
}

main().catch((error) => {
  console.error("Error deriving signer address:", error)
  process.exit(1)
})
