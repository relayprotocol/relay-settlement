// ABOUTME: Script to generate a test transaction manifest for verifying RelayMultisigSigner
// ABOUTME: Creates a simple self-transfer on Base to verify the derived address is correct

import { writeFileSync } from "fs"
import { join } from "path"
import { networks } from "@relay-protocol/settlement-networks"
import { createPublicClient, http } from "viem"
import { deriveAllocatorSignerAddress } from "../../../lib/signer"

// Get Aurora network config
const auroraNetwork = networks[1313161554n]
const RELAY_MULTISIG_SIGNER_ADDRESS = auroraNetwork.contracts.prod
  .multisigSigner as string
const AURORA_RPC = auroraNetwork.rpc[0]

// Use Base for testing
const BASE_CHAIN_ID = 8453n
const baseNetwork = networks[BASE_CHAIN_ID]

interface EvmTransaction {
  family: "ethereum-vm"
  rpc: string
  to: string
  calldata: string
  amount: string
  from: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  gas: string
  nonce: number
}

async function generateTestTransaction() {
  console.log("\n🧪 Generating test transaction manifest...\n")

  // Create Aurora client to query the RelayMultisigSigner
  const auroraClient = createPublicClient({
    chain: {
      id: 1313161554,
      name: "Aurora",
      nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
      rpcUrls: {
        default: { http: [AURORA_RPC] },
        public: { http: [AURORA_RPC] },
      },
    },
    transport: http(AURORA_RPC),
  })

  // Derive the signer address for Base (EVM)
  const signerAddress = await deriveAllocatorSignerAddress(
    auroraClient,
    RELAY_MULTISIG_SIGNER_ADDRESS,
    "ethereum-vm"
  )

  if (!signerAddress) {
    throw new Error("Failed to derive signer address")
  }

  console.log(`Derived signer address: ${signerAddress}`)
  console.log(`Testing on Base (Chain ID: ${BASE_CHAIN_ID})`)

  // Create Base client
  const baseClient = createPublicClient({
    chain: {
      id: Number(BASE_CHAIN_ID),
      name: "Base",
      nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
      rpcUrls: {
        default: { http: baseNetwork.rpc },
        public: { http: baseNetwork.rpc },
      },
    },
    transport: http(baseNetwork.rpc[0]),
  })

  // Get current nonce
  const nonce = await baseClient.getTransactionCount({
    address: signerAddress as `0x${string}`,
  })

  // Get fee data
  const feeData = await baseClient.estimateFeesPerGas()

  // Simple self-transfer of 0 ETH (no calldata needed)
  // This is the safest test - if the address doesn't have funds, it will fail at simulation
  const amount = "0" // 0 ETH to be safe

  // Estimate gas for the transfer
  const gasEstimate = await baseClient.estimateGas({
    account: signerAddress as `0x${string}`,
    to: signerAddress as `0x${string}`,
    value: BigInt(amount),
  })

  const transaction: EvmTransaction = {
    // No calldata for simple ETH transfer
    amount,
    // Self-transfer
    calldata: "0x",
    family: "ethereum-vm",

    from: signerAddress,
    gas: gasEstimate.toString(),
    maxFeePerGas: feeData.maxFeePerGas?.toString() || "0",
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || "0",
    nonce,
    rpc: baseNetwork.rpc[0],
    to: signerAddress,
  }

  // Write to file
  const outputDir = join(__dirname, "../transactions")
  const fileName = "020-test-multisig-signer.json"
  const outputPath = join(outputDir, fileName)

  writeFileSync(outputPath, JSON.stringify([transaction], null, 2))

  console.log("\n✅ Test transaction details:")
  console.log(`  From: ${signerAddress}`)
  console.log(`  To: ${signerAddress} (self-transfer)`)
  console.log(`  Amount: ${amount} ETH`)
  console.log(`  Chain: Base (${BASE_CHAIN_ID})`)
  console.log(`  Nonce: ${nonce}`)
  console.log(`\n📝 Manifest saved to: ${outputPath}`)
  console.log(
    `\n💡 Run simulation: yarn run hardhat relay-multisig-signer:simulate --transactions ${outputPath}`
  )
  console.log(
    "   This will verify the RelayMultisigSigner can sign for this address.\n"
  )
}

// Run the generator
generateTestTransaction().catch((error) => {
  console.error("Error generating test manifest:", error)
  process.exit(1)
})
