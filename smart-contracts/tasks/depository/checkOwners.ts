// ABOUTME: Task to check depository contract owners across all networks
// ABOUTME: Displays the owner address for each depository contract found in the networks config

import { task } from "hardhat/config"
import { networks } from "@relay-settlement/networks"
import { createPublicClient, http, getContract } from "viem"
import { Connection, PublicKey } from "@solana/web3.js"
import { BorshCoder } from "@coral-xyz/anchor"
import { IDL } from "../../lib/solana"

const DEPOSITORY_ABI = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const

task(
  "depository:check-owners",
  "Check depository contract owners for all networks"
).setAction(async () => {
  console.log("\n🔍 Checking depository owners across all networks...\n")

  const results: Array<{
    network: string
    chainId: string
    env: string
    address: string
    owner: string | null
    error?: string
  }> = []

  // Iterate through all networks
  for (const [chainId, config] of Object.entries(networks)) {
    const networkName = config.name || config.slug

    // Check both dev and prod environments
    for (const env of ["dev", "prod"] as const) {
      const contracts = config.contracts?.[env]
      const depositoryAddress = contracts?.depository

      if (depositoryAddress) {
        // Skip if no RPC configured or using placeholder
        if (
          !config.rpc ||
          config.rpc.length === 0 ||
          config.rpc[0].includes("nodes.svc.cluster.local")
        ) {
          console.log(
            `⏭️  ${networkName.padEnd(30)} (${env.padEnd(4)}) | Skipped (no public RPC configured)`
          )
          continue
        }

        // Handle different VM families
        if (config.family === "solana-vm") {
          // Handle Solana chains
          try {
            const connection = new Connection(config.rpc[0], {
              commitment: "confirmed",
              confirmTransactionInitialTimeout: 10000,
            })

            // The depositoryAddress is the program ID, derive the PDA
            const programId = new PublicKey(depositoryAddress)
            const [depositoryPDA] = PublicKey.findProgramAddressSync(
              [Buffer.from("relay_depository")],
              programId
            )

            const accountInfo = await connection.getAccountInfo(depositoryPDA)

            if (!accountInfo) {
              throw new Error("Depository account not found")
            }

            // Decode the account data using Borsh
            const coder = new BorshCoder(IDL)
            const decoded = coder.accounts.decode(
              "relayDepository",
              accountInfo.data
            )

            const owner = decoded.owner.toBase58()

            results.push({
              address: depositoryAddress,
              chainId,
              env,
              network: networkName,
              owner,
            })

            console.log(
              `✅ ${networkName.padEnd(30)} (${env.padEnd(4)}) | Owner: ${owner}`
            )
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error)
            results.push({
              address: depositoryAddress,
              chainId,
              env,
              error: errorMsg,
              network: networkName,
              owner: null,
            })

            let shortError = errorMsg
            if (errorMsg.includes("fetch") || errorMsg.includes("FetchError")) {
              shortError = "RPC endpoint unreachable"
            } else if (errorMsg.includes("Account not found")) {
              shortError = "Program account not found"
            } else if (
              errorMsg.includes("timeout") ||
              errorMsg.includes("timed out")
            ) {
              shortError = "RPC timeout"
            } else if (errorMsg.includes("discriminator")) {
              shortError = "Invalid account structure"
            }

            console.log(
              `❌ ${networkName.padEnd(30)} (${env.padEnd(4)}) | ${shortError} | RPC: ${config.rpc[0]}`
            )
          }
          continue
        }

        // Skip non-EVM, non-Solana chains for now
        if (config.family !== "ethereum-vm") {
          console.log(
            `⏭️  ${networkName.padEnd(30)} (${env.padEnd(4)}) | Skipped (unsupported VM family: ${config.family})`
          )
          continue
        }

        // Handle EVM chains
        try {
          // Create a public client for this network
          const client = createPublicClient({
            chain: {
              id: Number(chainId),
              name: networkName,
              nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
              rpcUrls: {
                default: { http: config.rpc },
                public: { http: config.rpc },
              },
            },
            transport: http(config.rpc[0], {
              timeout: 10_000, // 10 second timeout
            }),
          })

          // Get the depository contract
          const depository = getContract({
            abi: DEPOSITORY_ABI,
            address: depositoryAddress as `0x${string}`,
            client,
          })

          // Call owner()
          const owner = await depository.read.owner()

          results.push({
            address: depositoryAddress,
            chainId,
            env,
            network: networkName,
            owner: owner as string,
          })

          console.log(
            `✅ ${networkName.padEnd(30)} (${env.padEnd(4)}) | Owner: ${owner}`
          )
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error)
          results.push({
            address: depositoryAddress,
            chainId,
            env,
            error: errorMsg,
            network: networkName,
            owner: null,
          })

          // Shorten error for display
          let shortError = errorMsg
          if (errorMsg.includes("HTTP request failed")) {
            shortError = "RPC endpoint unreachable"
          } else if (errorMsg.includes("returned no data")) {
            shortError = "Contract not deployed or no owner()"
          } else if (errorMsg.includes("took too long")) {
            shortError = "RPC timeout"
          }

          console.log(
            `❌ ${networkName.padEnd(30)} (${env.padEnd(4)}) | ${shortError} | RPC: ${config.rpc[0]}`
          )
        }
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80))
  console.log("\n📊 Summary:")
  console.log(`Total depositories found: ${results.length}`)
  console.log(
    `Successfully checked: ${results.filter((r) => r.owner !== null).length}`
  )
  console.log(`Failed: ${results.filter((r) => r.owner === null).length}`)

  // Group by owner
  const ownerGroups = results
    .filter((r) => r.owner !== null)
    .reduce(
      (acc, r) => {
        if (!acc[r.owner!]) {
          acc[r.owner!] = []
        }
        acc[r.owner!].push(`${r.network} (${r.env})`)
        return acc
      },
      {} as Record<string, string[]>
    )

  console.log(`\n👥 Unique owners: ${Object.keys(ownerGroups).length}`)
  for (const [owner, networks] of Object.entries(ownerGroups)) {
    console.log(`\n  ${owner}:`)
    networks.forEach((net) => console.log(`    - ${net}`))
  }

  console.log("\n")
})
