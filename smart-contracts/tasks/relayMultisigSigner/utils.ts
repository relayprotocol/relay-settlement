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
  encodePacked,
} from "viem"
import { z } from "zod"
import * as bitcoin from "bitcoinjs-lib"
import { RelayMultisigSigner$Type } from "../../artifacts/contracts/RelayMultisigSigner.sol/RelayMultisigSigner"
import { buildBitcoinTransactionFromPayload } from "../../lib/bitcoin"
import { wait } from "../../lib/wait"
import { extractNearSignature } from "../../lib/near"
import { HardhatRuntimeEnvironment } from "hardhat/types"

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

export const EthereumTxSchema = z.object({
  amount: decimalString,
  calldata: hex0x,
  family: z.literal("ethereum-vm"),
  from: ethereumAddress,
  gas: integerString,
  maxFeePerGas: integerString,
  maxPriorityFeePerGas: integerString,
  nonce: z.number().int().nonnegative(),
  rpc: z.string().url(),
  to: ethereumAddress,
})

const BitcoinTxInputSchema = z.object({
  scriptPubKey: z.string(),
  txid: z.string(),
  value: z.number(),
  vout: z.number(),
})

const BitcoinTxOutputSchema = z.object({
  address: z.string(),
  value: z.number(),
})

export const BitcoinTxSchema = z.object({
  family: z.literal("bitcoin-vm"),
  feeRate: z.number().optional(),
  inputs: z.array(BitcoinTxInputSchema),
  network: z.enum(["mainnet", "testnet"]).optional(),
  outputs: z.array(BitcoinTxOutputSchema),
})

const EmptyTxSchema = z
  .object({
    family: z.enum(["solana-vm"]),
  })
  .strict() // disallow any other fields

export const TransactionSchema = z.discriminatedUnion("family", [
  EthereumTxSchema,
  BitcoinTxSchema,
  EmptyTxSchema,
])

// TS type
export type Transaction = z.infer<typeof TransactionSchema>

export const TransactionsSchema = z.array(TransactionSchema)

// Keeping track of offsets if there are multiple transactions from the same address
const nonceOffsets: Record<string, Record<number, number>> = {}

export type BuildTransactionResult = {
  hashesToSign: readonly `0x${string}`[]
  payload: `0x${string}`
  transaction: any
}

export const hasEvmTransactionBeenExecuted = async (
  tx: z.infer<typeof EthereumTxSchema>
) => {
  const networkClient = createPublicClient({
    transport: http(tx.rpc),
  })

  // Check the nonces!
  const nonce = await networkClient.getTransactionCount({
    address: tx.from,
  })

  return nonce > tx.nonce
}

export const hasBitcoinTransactionBeenExecuted = async (
  tx: z.infer<typeof BitcoinTxSchema>
) => {
  const baseUrl =
    tx.network === "mainnet"
      ? "https://mempool.space/api"
      : "https://mempool.space/testnet/api"

  // Check if any of the input UTXOs have been spent
  for (const input of tx.inputs) {
    const utxoRes = await fetch(
      `${baseUrl}/tx/${input.txid}/outspend/${input.vout}`
    )
    if (!utxoRes.ok) {
      // If we can't check, assume not executed
      return false
    }

    const spendData = await utxoRes.json()
    if (spendData.spent) {
      return true
    }
  }

  return false
}

export const buildEvmTransaction = async (
  tx: z.infer<typeof EthereumTxSchema>
): Promise<BuildTransactionResult> => {
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
    type: "eip1559",
    value: parseEther(tx.amount),
  }

  // Run a simulation!
  try {
    await networkClient.estimateGas({
      account: tx.from, // REQUIRED so the node simulates as your sender
      ...raw,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `❌ Ethereum transaction failed: ${JSON.stringify(tx)}, ${message}`
    )
  }

  // Add to the offset!
  nonceOffsets[tx.from][chainId] = (nonceOffsets[tx.from][chainId] || 0) + 1

  const transaction = {
    ...raw,
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  }

  const payload = serializeTransaction(transaction) // EVM
  const hashToSign = keccak256(payload)

  // Add the fees now only!
  return {
    hashesToSign: [hashToSign],
    payload,
    transaction,
  }
}

type BitcoinTransactionPayload = {
  fee: number
  feeRate: number
  inputs: Array<{
    index: `0x${string}`
    script: `0x${string}`
    txid: `0x${string}`
    value: `0x${string}`
  }>
  locktime: number
  outputs: Array<{
    script: `0x${string}`
    value: `0x${string}`
  }>
  version: number
}

export async function buildBitcoinTransaction(
  schema: z.infer<typeof BitcoinTxSchema>
): Promise<BuildTransactionResult> {
  const network =
    schema.network === "mainnet"
      ? bitcoin.networks.bitcoin
      : bitcoin.networks.testnet

  // Validate inputs exist
  if (schema.inputs.length === 0) {
    throw new Error("Transaction must have at least one input")
  }

  if (schema.outputs.length === 0) {
    throw new Error("Transaction must have at least one output")
  }

  // Validate scriptPubKey format for inputs
  for (const input of schema.inputs) {
    if (!/^[0-9a-fA-F]+$/.test(input.scriptPubKey)) {
      throw new Error(
        `Invalid scriptPubKey format for input ${input.txid}:${input.vout}`
      )
    }
  }

  // Validate transaction IDs
  for (const input of schema.inputs) {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) {
      throw new Error(`Invalid transaction ID format: ${input.txid}`)
    }
  }

  // Validate UTXOs against blockchain
  const baseUrl =
    schema.network === "mainnet"
      ? "https://mempool.space/api"
      : "https://mempool.space/testnet/api"

  for (const input of schema.inputs) {
    // Fetch transaction details
    const txRes = await fetch(`${baseUrl}/tx/${input.txid}`)
    if (!txRes.ok) {
      throw new Error(`Transaction ${input.txid} not found`)
    }

    const txData = await txRes.json()

    // Check if the output exists
    if (input.vout >= txData.vout.length) {
      throw new Error(
        `Output ${input.vout} does not exist in transaction ${input.txid}`
      )
    }

    const output = txData.vout[input.vout]

    // Verify the value matches
    if (output.value !== input.value) {
      throw new Error(
        `Value mismatch for ${input.txid}:${input.vout} - expected ${input.value}, found ${output.value}`
      )
    }

    // Verify the scriptPubKey matches
    if (output.scriptpubkey !== input.scriptPubKey) {
      throw new Error(
        `scriptPubKey mismatch for ${input.txid}:${input.vout} - expected ${input.scriptPubKey}, found ${output.scriptpubkey}`
      )
    }

    // Check if UTXO is spent
    const utxoRes = await fetch(
      `${baseUrl}/tx/${input.txid}/outspend/${input.vout}`
    )
    if (utxoRes.ok) {
      const spendData = await utxoRes.json()
      if (spendData.spent) {
        throw new Error(
          `UTXO ${input.txid}:${input.vout} is already spent in transaction ${spendData.txid}`
        )
      }
    }

    // Log confirmation status
    if (!txData.status?.confirmed) {
      console.log(`  ⚠️  UTXO ${input.txid}:${input.vout} is unconfirmed`)
    }
  }

  // Calculate total input value
  const totalInputValue = schema.inputs.reduce(
    (sum, input) => sum + input.value,
    0
  )

  // Calculate total output value
  const totalOutputValue = schema.outputs.reduce(
    (sum, output) => sum + output.value,
    0
  )

  // Calculate fee
  const fee = totalInputValue - totalOutputValue

  // Validate that fee is positive
  if (fee < 0) {
    throw new Error("Insufficient funds: output value exceeds input value")
  }

  // Estimate transaction size and check fee rate
  const estimatedInputSize = schema.inputs.length * 148
  const estimatedOutputSize = schema.outputs.length * 34
  const estimatedSize = 10 + estimatedInputSize + estimatedOutputSize
  const feeRate = schema.feeRate || 1
  const recommendedFee = Math.ceil(estimatedSize * feeRate)

  if (fee < recommendedFee) {
    console.log(
      `  ⚠️  Fee (${fee} sats) is below recommended (${recommendedFee} sats) for ${feeRate} sat/vByte`
    )
  }

  // Validate addresses
  for (const output of schema.outputs) {
    try {
      bitcoin.address.toOutputScript(output.address, network)
    } catch {
      throw new Error(
        `Invalid Bitcoin address: ${output.address}. Are you sure this is the correct network?`
      )
    }
  }

  // Build transaction representation
  const transaction: BitcoinTransactionPayload = {
    fee,
    feeRate: schema.feeRate || 1,
    inputs: schema.inputs.map((input) => {
      // Encode index (vout) as little-endian 4 bytes
      const indexBuffer = Buffer.alloc(4)
      indexBuffer.writeUInt32LE(input.vout, 0)

      // Encode value as little-endian 8 bytes
      const valueBuffer = Buffer.alloc(8)
      valueBuffer.writeBigUInt64LE(BigInt(input.value), 0)

      return {
        index: `0x${indexBuffer.toString("hex")}`,
        script: `0x${input.scriptPubKey}`,
        txid: `0x${Buffer.from(input.txid, "hex").reverse().toString("hex")}`,
        value: `0x${valueBuffer.toString("hex")}`,
      }
    }),
    locktime: 0,
    outputs: schema.outputs.map((output) => {
      // Convert address to script, handle errors gracefully
      let script: Buffer
      try {
        script = bitcoin.address.toOutputScript(output.address, network)
      } catch {
        // If address doesn't work with specified network, try the other network
        const fallbackNetwork =
          network === bitcoin.networks.bitcoin
            ? bitcoin.networks.testnet
            : bitcoin.networks.bitcoin
        script = bitcoin.address.toOutputScript(output.address, fallbackNetwork)
      }

      // Encode value as little-endian 8 bytes
      const valueBuffer = Buffer.alloc(8)
      valueBuffer.writeBigUInt64LE(BigInt(output.value), 0)

      return {
        script: `0x${script.toString("hex")}`,
        value: `0x${valueBuffer.toString("hex")}`,
      }
    }),
    version: 1,
  }
  const tx = buildBitcoinTransactionFromPayload(transaction)

  const hashesToSign = transaction.inputs.map((input, index) => {
    const scriptPubKey = Buffer.from(schema.inputs[index].scriptPubKey, "hex")
    const sighash = tx.hashForSignature(
      index,
      scriptPubKey,
      bitcoin.Transaction.SIGHASH_ALL
    )
    return `0x${sighash.toString("hex")}` as const
  })

  const unsignedTransaction = `0x${tx.toHex()}` as const

  return {
    hashesToSign,
    payload: unsignedTransaction,
    transaction,
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
    const tx = transactions[i]
    let result
    let curve: "Ecdsa" | "Eddsa"
    if (tx.family === "ethereum-vm") {
      result = await buildEvmTransaction(EthereumTxSchema.parse(tx))
      curve = "Ecdsa"
    } else if (tx.family === "bitcoin-vm") {
      result = await buildBitcoinTransaction(BitcoinTxSchema.parse(tx))
      curve = "Ecdsa"
    } else {
      throw new Error(
        `Unsupported transaction family: ${tx.family}. Please add support!`
      )
    }

    result.hashesToSign.forEach((hash, index) => {
      const useRawData = tx.family === "solana-vm"
      console.log(
        `🏗️  Building ${useRawData ? "raw data" : "hash"} #${index} for tx #${i} (${tx.family}) : ${hash}`
      )
      const transactionForBundle = encodeSignatureCall(
        hash,
        curve,
        relayMultisigSigner,
        useRawData
      )
      transactionBundle.push(transactionForBundle)
    })
  }
  return transactionBundle
}

const encodeSignatureCall = (
  hashToSign: `0x${string}`,
  curve: "Ecdsa" | "Eddsa",
  relayMultisigSigner: RelayMultisigSigner$Type,
  raw: boolean = false
) => {
  // Use unified approve function for both hash and raw data
  const data = raw ? hashToSign : encodePacked(["bytes32"], [hashToSign])

  const callData = encodeFunctionData({
    abi: relayMultisigSigner.abi,
    args: [data, curve],
    functionName: "approve",
  })

  return {
    data: callData,
    to: checksumAddress(relayMultisigSigner.address),
    value: "0",
  }
}

const signGas = 50_000_000_000_000n
const callbackGas = 30_000_000_000_000n

export const getSignatureForHash = async (
  relayMultisigSigner: string,
  hashToSign: string,
  curve: string,
  hre: HardhatRuntimeEnvironment,
  raw: boolean = false
): Promise<string> => {
  const multisigSigner = await hre.viem.getContractAt(
    "RelayMultisigSigner",
    relayMultisigSigner
  )

  // Prepare data and determine the key for lookups
  const data = raw
    ? (hashToSign as `0x${string}`)
    : encodePacked(["bytes32"], [hashToSign as `0x${string}`])

  const signatureKey = keccak256(data)

  let nearSignature = await multisigSigner.read.signatures([
    signatureKey,
    curve,
  ])

  if (nearSignature === "0x") {
    // Check if the signature was approved
    const approved = await multisigSigner.read.approvedSignatures([
      signatureKey,
      curve,
    ])
    if (!approved) {
      throw new Error(
        `❌ ${raw ? "Raw data" : "Hash"} signature not approved...`
      )
    }

    console.log(`📝 Requesting ${raw ? "raw data" : "hash"} signature...`, {
      curve,
      [raw ? "rawData" : "hashToSign"]: hashToSign,
      ...(raw ? { dataHash: signatureKey } : {}),
    })

    // Use unified sign function
    const txHash = await multisigSigner.write.sign([
      data,
      curve,
      signGas,
      callbackGas,
    ])

    const publicClient = await hre.viem.getPublicClient()
    await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
  }

  while (nearSignature === "0x") {
    console.log(`Waiting for signed ${raw ? "raw data" : "hash"}...`)
    await wait(1)
    nearSignature = await multisigSigner.read.signatures([signatureKey, curve])
  }

  const { r, s, v } = extractNearSignature(nearSignature)
  const hexSignature =
    `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`

  return hexSignature
}
