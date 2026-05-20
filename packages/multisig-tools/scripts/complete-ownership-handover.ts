// ABOUTME: Generates transactions for current owners to complete ownership handover of depository contracts
// ABOUTME: This is step 2 of the ownership transfer process - the current owner completes the handover

import {
  createPublicClient,
  encodeFunctionData,
  getContract,
  http,
  parseEther,
} from "viem"
import { networks } from "@relay-protocol/settlement-networks"
import { ErrorType } from "viem/_types/errors/utils"
import { IRelayDespository } from "../src/crypto/evm"
import { derivePublicKey } from "../src/crypto/near"
import { computeEvmAddress, getDomainId } from "../src/crypto/signer"

// Environment to transfer (prod or dev)
const ENV: "prod" | "dev" = "prod"

const main = async () => {
  console.error(
    `Generating completeOwnershipHandover transactions for ${ENV} depositories...`
  )

  // Get the new RelayMultisigSigner address from Aurora network config
  const auroraConfig = networks["1313161554"]
  if (!auroraConfig) {
    throw new Error("Aurora network config not found")
  }

  const NEW_MULTISIG_SIGNER = auroraConfig.contracts?.[ENV]?.multisigSigner
  if (!NEW_MULTISIG_SIGNER) {
    throw new Error(
      `No multisigSigner address found in Aurora ${ENV} config. Please add it to the network config.`
    )
  }

  // Derive the actual signer address from the RelayMultisigSigner
  const auroraRpc = createPublicClient({
    transport: http(auroraConfig.rpc[0]),
  })

  // Get the near signer from the multisig contract
  const nearSigner = (await auroraRpc.readContract({
    abi: [
      {
        inputs: [],
        name: "nearSigner",
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    address: NEW_MULTISIG_SIGNER as `0x${string}`,
    functionName: "nearSigner",
  })) as string

  const derivationPath = NEW_MULTISIG_SIGNER.toLowerCase()
  const predecessor = `${NEW_MULTISIG_SIGNER.substring(2).toLowerCase()}.aurora`
  const nearRpcUrl = "https://free.rpc.fastnear.com"

  // Get the public key from the NEAR signer contract
  const { publicKey } = await derivePublicKey(
    derivationPath,
    predecessor,
    getDomainId("ethereum-vm"),
    nearSigner,
    nearRpcUrl
  )

  // Compute the EVM address from the public key
  const DERIVED_SIGNER_ADDRESS = computeEvmAddress(publicKey)

  console.error(`New multisig signer contract: ${NEW_MULTISIG_SIGNER}`)
  console.error(
    `Derived signer address (pending owner): ${DERIVED_SIGNER_ADDRESS}\n`
  )

  const txs: any[] = []
  const skipped: string[] = []
  const noHandoverRequested: string[] = []
  const errors: Array<{ network: string; error: string }> = []

  for (const [chainId, networkConfig] of Object.entries(networks)) {
    const depositoryAddress = networkConfig.contracts?.[ENV]?.depository

    // Skip if no depository for this environment
    if (!depositoryAddress) {
      continue
    }

    // Skip non-EVM chains
    if (networkConfig.family !== "ethereum-vm") {
      skipped.push(
        `${networkConfig.name} (${chainId}): ${networkConfig.family} not supported`
      )
      continue
    }

    // Skip if no RPC or using placeholder
    if (
      !networkConfig.rpc ||
      networkConfig.rpc.length === 0 ||
      networkConfig.rpc[0].includes("nodes.svc.cluster.local")
    ) {
      skipped.push(`${networkConfig.name} (${chainId}): No public RPC`)
      continue
    }

    try {
      const rpc = createPublicClient({
        transport: http(networkConfig.rpc[0], { timeout: 10_000 }),
      })

      // Get current owner of the depository
      const depository = getContract({
        abi: IRelayDespository,
        address: depositoryAddress as `0x${string}`,
        client: rpc,
      })

      const currentOwner = await depository.read.owner()

      // Check if ownership handover has been requested by the derived signer address
      const handoverExpiresAt =
        await depository.read.ownershipHandoverExpiresAt([
          DERIVED_SIGNER_ADDRESS as `0x${string}`,
        ])

      // If handoverExpiresAt is 0, no handover has been requested
      if (handoverExpiresAt === 0n) {
        noHandoverRequested.push(
          `${networkConfig.name} (${chainId}): No handover requested yet`
        )
        continue
      }

      // Check if handover has expired
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (handoverExpiresAt < now) {
        noHandoverRequested.push(
          `${networkConfig.name} (${chainId}): Handover expired at ${new Date(Number(handoverExpiresAt) * 1000).toISOString()}`
        )
        continue
      }

      const fees = await rpc.estimateFeesPerGas().catch(async (error) => {
        if (
          (error as ErrorType).name?.includes("Eip1559FeesNotSupportedError")
        ) {
          return {
            gasPrice: await rpc.getGasPrice(),
            maxFeePerGas: undefined,
            maxPriorityFeePerGas: undefined,
          }
        }

        throw error
      })

      // completeOwnershipHandover(address pendingOwner) calldata
      const calldata = encodeFunctionData({
        abi: IRelayDespository,
        args: [DERIVED_SIGNER_ADDRESS],
        functionName: "completeOwnershipHandover",
      })

      const txData = {
        amount: "0",
        calldata,
        from: currentOwner,
        to: depositoryAddress,
      } as const

      const gas = await rpc.estimateGas({
        account: txData.from,
        data: txData.calldata,
        to: txData.to as `0x${string}`,
        value: parseEther(txData.amount),
      })

      const tx = {
        chainId: Number(chainId),
        currentOwner,
        family: "ethereum-vm",
        gas: ((gas * 110n) / 100n).toString(),
        gasPrice: fees.gasPrice
          ? ((fees.gasPrice! * 110n) / 100n).toString()
          : undefined,
        maxFeePerGas: fees.maxFeePerGas
          ? ((fees.maxFeePerGas * 110n) / 100n).toString()
          : undefined,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas
          ? ((fees.maxPriorityFeePerGas * 110n) / 100n).toString()
          : undefined,
        network: networkConfig.name,
        nonce: await rpc.getTransactionCount({ address: txData.from }),
        rpc: networkConfig.rpc[0],
        ...txData,
      }

      txs.push(tx)
      const expiresDate = new Date(Number(handoverExpiresAt) * 1000)
      console.error(
        `✅ ${networkConfig.name.padEnd(30)} (${chainId}) | Owner: ${currentOwner} | Expires: ${expiresDate.toISOString()}`
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      errors.push({ error: errorMsg, network: networkConfig.name })
      console.error(
        `❌ ${networkConfig.name.padEnd(30)} (${chainId}): ${errorMsg}`
      )
    }
  }

  console.error(`\n${"=".repeat(80)}`)
  console.error(`\n✅ Generated ${txs.length} transactions`)
  console.error(
    `⏭️  Skipped ${skipped.length} networks (no depository/RPC/non-EVM)`
  )
  console.error(
    `⏸️  No handover requested: ${noHandoverRequested.length} networks`
  )
  console.error(`❌ Failed ${errors.length} networks`)

  if (skipped.length > 0) {
    console.error("\nSkipped:")
    skipped.forEach((s) => console.error(`  - ${s}`))
  }

  if (noHandoverRequested.length > 0) {
    console.error("\nNo handover requested (will not complete):")
    noHandoverRequested.forEach((s) => console.error(`  - ${s}`))
  }

  if (errors.length > 0) {
    console.error("\nErrors:")
    errors.forEach((e) => console.error(`  - ${e.network}: ${e.error}`))
  }

  // Group by current owner
  const ownerGroups = txs.reduce(
    (acc, tx) => {
      if (!acc[tx.currentOwner]) {
        acc[tx.currentOwner] = []
      }
      acc[tx.currentOwner].push(tx.network)
      return acc
    },
    {} as Record<string, string[]>
  )

  console.error(`\n👥 Current owners (${Object.keys(ownerGroups).length}):`)
  for (const [owner, nets] of Object.entries(ownerGroups)) {
    console.error(`\n  ${owner}:`)
    console.error(`    ${nets.length} network(s): ${nets.join(", ")}`)
  }

  console.error(`\n${"=".repeat(80)}\n`)
  console.log(JSON.stringify(txs, null, 2))
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
