// ABOUTME: Generates transactions for new multisig signer to request ownership handover of depository contracts
// ABOUTME: This is step 1 of the ownership transfer process - the new owner requests the handover

import { createPublicClient, encodeFunctionData, http, parseEther } from "viem"
import { networks } from "@relay-protocol/settlement-networks"
import { ErrorType } from "viem/_types/errors/utils"
import { IRelayDespository } from "../src/crypto/evm"
import { derivePublicKey } from "../src/crypto/near"
import { computeEvmAddress, getDomainId } from "../src/crypto/signer"

// Environment to transfer (prod or dev)
const ENV: "prod" | "dev" = "prod"

const main = async () => {
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

  const txs: any[] = []
  const skipped: string[] = []
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

    try {
      const rpc = createPublicClient({
        transport: http(networkConfig.rpc[0], { timeout: 10_000 }),
      })

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

      // requestOwnershipHandover() calldata
      const calldata = encodeFunctionData({
        abi: IRelayDespository,
        functionName: "requestOwnershipHandover",
      })

      const txData = {
        amount: "0",
        calldata,
        from: DERIVED_SIGNER_ADDRESS,
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
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      errors.push({ error: errorMsg, network: networkConfig.name })
    }
  }

  console.log(JSON.stringify(txs, null, 2))
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
