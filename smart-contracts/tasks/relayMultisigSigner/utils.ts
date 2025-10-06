import { readFileSync } from "fs"
import {
  checksumAddress,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEther,
  serializeTransaction,
} from "viem"
import { z } from "zod"
import { RelayMultisigSigner$Type } from "../../artifacts/contracts/RelayMultisigSigner.sol/RelayMultisigSigner"

const ethereumAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid hex Ethereum address")
  .superRefine((val, ctx) => {
    try {
      // getAddress throws if checksum is invalid
      getAddress(val)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Ethereum checksum address",
      })
    }
  })

const hex0x = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "Must be a 0x-prefixed hex string")

const integerString = z
  .string()
  .regex(/^[0-9]+$/, "Must be a non-negative integer string")

const decimalString = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/, "Must be a decimal number string")

const EthereumTxSchema = z.object({
  amount: decimalString,
  calldata: hex0x,
  family: z.literal("ethereum-vm"),
  from: ethereumAddress,
  gas: integerString,
  gasPrice: integerString.optional(),
  maxFeePerGas: integerString.optional(),
  maxPriorityFeePerGas: integerString.optional(),
  nonce: z.number().int().nonnegative(),
  rpc: z.string().url(),
  to: ethereumAddress,
})

const EmptyTxSchema = z
  .object({
    family: z.enum(["bitcoin-vm", "solana-vm"]),
  })
  .strict() // disallow any other fields

export const TransactionSchema = z.discriminatedUnion("family", [
  EthereumTxSchema,
  EmptyTxSchema,
])

// TS type
export type Transaction = z.infer<typeof TransactionSchema>

export const TransactionsSchema = z.array(TransactionSchema)

// Keeping track of offsets if there are multiple transactions from the same address
const nonceOffsets: Record<string, Record<number, number>> = {}

export const buildEvmTransaction = async (
  tx: z.infer<typeof EthereumTxSchema>
) => {
  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })
  const chainId = await networkClient.getChainId()

  const nonce = await networkClient.getTransactionCount({
    address: tx.from,
  })
  if (!nonceOffsets[tx.from]) {
    nonceOffsets[tx.from] = {}
  }
  const expectedNonce = nonce + (nonceOffsets[tx.from][chainId] || 0)
  if (expectedNonce !== tx.nonce) {
    throw new Error(
      `❌ Nonce mismatch: the transaction nonce is ${tx.nonce} but the current nonce is ${expectedNonce}. This tx will not be executed!`
    )
  }
  const raw = {
    chainId,
    data: tx.calldata,
    from: tx.from,
    gas: BigInt(tx.gas),
    nonce: tx.nonce,
    to: tx.to,
    type: tx.gasPrice ? "legacy" : "eip1559",
    value: parseEther(tx.amount),
  }

  // Run a simulation!
  try {
    await networkClient.estimateGas({
      account: tx.from, // REQUIRED so the node simulates as your sender
      ...raw,
    })
  } catch (error: any) {
    console.error("❌ Ethereum transaction failed:", tx, error.message)
    return null
  }

  // Add to the offset!
  nonceOffsets[tx.from][chainId] = (nonceOffsets[tx.from][chainId] || 0) + 1

  // Add the fees now only!
  return {
    ...raw,
    gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas
      ? BigInt(tx.maxPriorityFeePerGas)
      : undefined,
  }
}

export function loadTransactions(path: string) {
  const raw = readFileSync(path, "utf8")
  const data: unknown = JSON.parse(raw)

  // Force validation
  return TransactionsSchema.parse(data)
}

export const createTransactionBundle = async (
  transactionsPath: string,
  relayMultisigSigner: RelayMultisigSigner$Type
) => {
  const transactions = loadTransactions(transactionsPath)

  const transactionBundle = []

  for (let i = 0; i < transactions.length; i++) {
    console.log(`🏗️  Building transaction #${i}`)
    const tx = transactions[i]
    let rawUnsigned
    let curve: "Ecdsa" | "Eddsa"
    if (tx.family === "ethereum-vm") {
      const transaction = await buildEvmTransaction(tx)
      if (!transaction) {
        throw new Error("Failed to build EVM transaction")
      }
      rawUnsigned = serializeTransaction(transaction) // EVM
      curve = "Ecdsa"
    } else {
      throw new Error(
        `Unsupported transaction family: ${tx.family}. Please add support!`
      )
    }

    const transactionForBundle = encodeSignatureCall(
      rawUnsigned,
      curve,
      relayMultisigSigner
    )
    transactionBundle.push(transactionForBundle)
  }
  return transactionBundle
}

const encodeSignatureCall = (
  rawUnsigned: `0x${string}`,
  curve: "Ecdsa" | "Eddsa",
  relayMultisigSigner: RelayMultisigSigner$Type
) => {
  const hashToSign = keccak256(rawUnsigned)

  const data = encodeFunctionData({
    abi: relayMultisigSigner.abi,
    args: [hashToSign, curve],
    functionName: "approveSignature",
  })

  return {
    data,
    to: checksumAddress(relayMultisigSigner.address),
    value: "0",
  }
}
